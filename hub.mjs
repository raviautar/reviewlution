/**
 * Hub mode's routing half: one review ingress per live pull-request preview.
 *
 * A preview is an ingress named `<app>-pr-<n>` (ArgoCD renders one per open
 * PR). For each, the hub keeps `review-hub-pr-<n>`, which sends
 * `<app>-pr-<n>-review.<domain>` to the hub's own service with the preview's
 * ingress class, TLS issuer and DNS settings; when the preview goes, its review
 * ingress goes too. The hub only changes or deletes ingresses it labelled
 * itself. The preview's labels are not copied: its ArgoCD tracking label would
 * make ArgoCD treat ours as its own and prune it.
 */
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

const MANAGED_BY = 'review-hub';
const COPIED_ANNOTATIONS = [
  'kubernetes.io/ingress.class',
  'cert-manager.io/cluster-issuer',
  'external-dns.alpha.kubernetes.io/cloudflare-proxied',
  'external-dns.alpha.kubernetes.io/ttl',
];
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `<app>-pr-<n>` when `host` is that preview's review host, else null. */
export function previewOfHost(app, host) {
  const label = String(host ?? '').split(':')[0].split('.')[0].toLowerCase();
  const m = new RegExp(`^(${escapeRe(app)}-pr-\\d+)-review$`).exec(label);
  return m ? m[1] : null;
}

/** The review ingress for one preview ingress; null when the preview has no host. */
export function reviewIngressFor(preview, service, port) {
  const host = preview.spec?.rules?.[0]?.host;
  const n = /-pr-(\d+)$/.exec(preview.metadata.name)?.[1];
  if (!host || !n) return null;
  const reviewHost = host.replace(/^[^.]+/, (label) => `${label}-review`);
  const annotations = { 'external-dns.alpha.kubernetes.io/hostname': reviewHost };
  for (const key of COPIED_ANNOTATIONS) {
    const value = preview.metadata.annotations?.[key];
    if (value !== undefined) annotations[key] = value;
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: `${MANAGED_BY}-pr-${n}`,
      labels: {
        'app.kubernetes.io/name': 'review-toolbar',
        'app.kubernetes.io/managed-by': MANAGED_BY,
        'wand.ai/review-of': preview.metadata.name,
      },
      annotations,
    },
    spec: {
      ...(preview.spec.ingressClassName ? { ingressClassName: preview.spec.ingressClassName } : {}),
      rules: [
        {
          host: reviewHost,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'ImplementationSpecific',
                backend: { service: { name: service, port: { number: port } } },
              },
            ],
          },
        },
      ],
      ...(preview.spec.tls?.length ? { tls: [{ hosts: [reviewHost], secretName: `${reviewHost}-tls` }] } : {}),
    },
  };
}

const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/** Whether an existing review ingress already says everything `want` says. */
function matches(have, want) {
  const sub = (a = {}, b = {}) => Object.entries(b).every(([k, v]) => a[k] === v);
  return (
    sub(have.metadata.labels, want.metadata.labels) &&
    sub(have.metadata.annotations, want.metadata.annotations) &&
    canonical(have.spec) === canonical(want.spec)
  );
}

/**
 * What to change so every preview of `app` has exactly one review ingress:
 * create it where it is missing, update ours where it drifted, delete ours
 * whose preview is gone. A review host some other ingress already serves
 * (a hand-made shell, say) is left to that ingress.
 */
export function plan(app, ingresses, service, port) {
  const previewName = new RegExp(`^${escapeRe(app)}-pr-\\d+$`);
  const ours = new Map();
  const others = [];
  for (const ing of ingresses) {
    if (ing.metadata.labels?.['app.kubernetes.io/managed-by'] === MANAGED_BY) ours.set(ing.metadata.name, ing);
    else others.push(ing);
  }
  const otherHosts = new Set(others.flatMap((i) => (i.spec?.rules ?? []).map((r) => r.host)));
  const otherNames = new Set(others.map((i) => i.metadata.name));
  const out = { create: [], update: [], remove: [], skipped: [], previews: [] };
  for (const preview of others) {
    if (!previewName.test(preview.metadata.name)) continue;
    const want = reviewIngressFor(preview, service, port);
    if (!want) continue;
    const host = want.spec.rules[0].host;
    if (otherHosts.has(host) || otherNames.has(want.metadata.name)) {
      out.skipped.push({ preview: preview.metadata.name, host });
      continue;
    }
    out.previews.push(preview.metadata.name);
    const have = ours.get(want.metadata.name);
    ours.delete(want.metadata.name);
    if (!have) out.create.push(want);
    else if (!matches(have, want)) {
      out.update.push({ ...want, metadata: { ...want.metadata, resourceVersion: have.metadata.resourceVersion } });
    }
  }
  out.remove = [...ours.keys()];
  return out;
}

/** One call to the Kubernetes API with the pod's service account. */
async function kube(method, path, body) {
  const [token, ca] = await Promise.all([readFile(`${SA}/token`, 'utf8'), readFile(`${SA}/ca.crt`)]);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: process.env.KUBERNETES_SERVICE_PORT ?? 443,
        method,
        path,
        ca,
        timeout: 10_000,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token.trim()}`,
          ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 300) reject(new Error(`${method} ${path} → ${res.statusCode} ${text.slice(0, 300)}`));
          else resolve(text ? JSON.parse(text) : null);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Reconcile now and then every `intervalMs`, one run at a time. Returns the
 * live state the health endpoint reports.
 */
export function startReconciler({ app, service, port, intervalMs, log }) {
  const state = { previews: [], skipped: [], lastRun: null, errors: [] };
  const run = async () => {
    const errors = [];
    try {
      const ns = (await readFile(`${SA}/namespace`, 'utf8')).trim();
      const base = `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`;
      const { items } = await kube('GET', base);
      const p = plan(app, items, service, port);
      const act = async (what, name, call) => {
        try {
          await call();
          log.info({ ingress: name }, `review ingress ${what}`);
        } catch (err) {
          errors.push(err.message);
          log.error({ ingress: name, err: err.message }, `review ingress not ${what}`);
        }
      };
      for (const ing of p.create) await act('created', ing.metadata.name, () => kube('POST', base, ing));
      for (const ing of p.update)
        await act('updated', ing.metadata.name, () => kube('PUT', `${base}/${ing.metadata.name}`, ing));
      for (const name of p.remove) await act('deleted', name, () => kube('DELETE', `${base}/${name}`));
      state.previews = p.previews;
      state.skipped = p.skipped;
    } catch (err) {
      errors.push(err.message);
      log.error({ err: err.message }, 'review ingress reconcile failed');
    }
    state.lastRun = new Date().toISOString();
    state.errors = errors;
  };
  const loop = async () => {
    await run();
    setTimeout(loop, intervalMs);
  };
  loop();
  return state;
}
