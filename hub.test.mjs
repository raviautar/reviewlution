import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan, previewOfHost, reviewIngressFor } from './hub.mjs';

const preview = (n, extra = {}) => ({
  metadata: {
    name: `wand-studio-pr-${n}`,
    labels: { 'argocd.argoproj.io/instance': 'wand-studio', 'wand.ai/preview': `pr-${n}` },
    annotations: {
      'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
      'kubernetes.io/ingress.class': 'internal',
      'external-dns.alpha.kubernetes.io/hostname': `wand-studio-pr-${n}.dev.wand.ai`,
      'external-dns.alpha.kubernetes.io/cloudflare-proxied': 'false',
      'external-dns.alpha.kubernetes.io/ttl': '120',
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
    },
  },
  spec: {
    ingressClassName: 'internal',
    rules: [{ host: `wand-studio-pr-${n}.dev.wand.ai` }],
    tls: [{ hosts: [`wand-studio-pr-${n}.dev.wand.ai`], secretName: `wand-studio-pr-${n}.dev.wand.ai-tls` }],
    ...extra,
  },
});
const managed = (n) => ({
  ...reviewIngressFor(preview(n), 'review-hub', 8090),
  metadata: { ...reviewIngressFor(preview(n), 'review-hub', 8090).metadata, resourceVersion: '7' },
});

test('a review host names its preview; anything else names none', () => {
  assert.equal(previewOfHost('wand-studio', 'wand-studio-pr-79-review.dev.wand.ai'), 'wand-studio-pr-79');
  assert.equal(previewOfHost('wand-studio', 'Wand-Studio-PR-7-review.dev.wand.ai:443'), 'wand-studio-pr-7');
  assert.equal(previewOfHost('wand-studio', 'wand-studio-pr-79.dev.wand.ai'), null);
  assert.equal(previewOfHost('wand-studio', 'studio.dev.wand.ai'), null);
  assert.equal(previewOfHost('wand-studio', 'wand-studio-pr-x-review.dev.wand.ai'), null);
  assert.equal(previewOfHost('wand-studio', '10.244.1.7:8090'), null);
  assert.equal(previewOfHost('wand-studio', undefined), null);
});

test("the review ingress takes the preview's class, issuer and DNS settings, never its labels", () => {
  const ing = reviewIngressFor(preview(79), 'review-hub', 8090);
  assert.equal(ing.metadata.name, 'review-hub-pr-79');
  assert.equal(ing.spec.rules[0].host, 'wand-studio-pr-79-review.dev.wand.ai');
  assert.deepEqual(ing.spec.rules[0].http.paths[0].backend, { service: { name: 'review-hub', port: { number: 8090 } } });
  assert.deepEqual(ing.spec.tls, [
    { hosts: ['wand-studio-pr-79-review.dev.wand.ai'], secretName: 'wand-studio-pr-79-review.dev.wand.ai-tls' },
  ]);
  assert.equal(ing.spec.ingressClassName, 'internal');
  assert.deepEqual(ing.metadata.annotations, {
    'external-dns.alpha.kubernetes.io/hostname': 'wand-studio-pr-79-review.dev.wand.ai',
    'kubernetes.io/ingress.class': 'internal',
    'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
    'external-dns.alpha.kubernetes.io/cloudflare-proxied': 'false',
    'external-dns.alpha.kubernetes.io/ttl': '120',
  });
  assert.equal(ing.metadata.labels['argocd.argoproj.io/instance'], undefined);
  assert.equal(ing.metadata.labels['wand.ai/preview'], undefined);
});

test('every preview without a review ingress gets one; other ingresses are not previews', () => {
  const studio = { metadata: { name: 'wand-studio-service' }, spec: { rules: [{ host: 'studio.dev.wand.ai' }] } };
  const p = plan('wand-studio', [preview(78), preview(79), studio], 'review-hub', 8090);
  assert.deepEqual(
    p.create.map((i) => i.metadata.name),
    ['review-hub-pr-78', 'review-hub-pr-79'],
  );
  assert.deepEqual(p.previews, ['wand-studio-pr-78', 'wand-studio-pr-79']);
  assert.deepEqual([p.update, p.remove, p.skipped], [[], [], []]);
});

test('a review ingress already in place is left as it is', () => {
  const p = plan('wand-studio', [preview(79), managed(79)], 'review-hub', 8090);
  assert.deepEqual([p.create, p.update, p.remove], [[], [], []]);
});

test('a review ingress that drifted is put back, keeping its resourceVersion', () => {
  const drifted = managed(79);
  drifted.spec = { ...drifted.spec, rules: [{ ...drifted.spec.rules[0], host: 'elsewhere.dev.wand.ai' }] };
  const p = plan('wand-studio', [preview(79), drifted], 'review-hub', 8090);
  assert.equal(p.update.length, 1);
  assert.equal(p.update[0].metadata.resourceVersion, '7');
  assert.equal(p.update[0].spec.rules[0].host, 'wand-studio-pr-79-review.dev.wand.ai');
});

test("ours goes when its preview goes; an ingress we did not make is never touched", () => {
  const handMade = {
    metadata: { name: 'review-toolbar-pr-60', labels: { 'wand.ai/preview': 'pr-60' } },
    spec: { rules: [{ host: 'wand-studio-pr-60-review.dev.wand.ai' }] },
  };
  const p = plan('wand-studio', [managed(70), handMade], 'review-hub', 8090);
  assert.deepEqual(p.remove, ['review-hub-pr-70']);
  assert.deepEqual([p.create, p.update], [[], []]);
});

test('a review host another ingress already serves is skipped, not doubled', () => {
  const handMade = {
    metadata: { name: 'review-toolbar-pr-60' },
    spec: { rules: [{ host: 'wand-studio-pr-60-review.dev.wand.ai' }] },
  };
  const p = plan('wand-studio', [preview(60), handMade], 'review-hub', 8090);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.skipped, [{ preview: 'wand-studio-pr-60', host: 'wand-studio-pr-60-review.dev.wand.ai' }]);
});
