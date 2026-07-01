/**
 * Regression test for the prod image-pin bump. Run with:
 *   node --test pin.test.js
 *
 * Guards the latent bug that shipped an inert /approve: the console prod overlay
 * pins the image via concrete `image: <registry>/infraweaver-console:<tag>` lines
 * (initContainer + container), NOT a kustomize `newTag:` field. The old sed
 * targeted `newTag:` and silently matched nothing, so the pin never moved.
 *
 * Requiring ./server.js is side-effect free (server.listen is guarded by
 * `require.main === module`).
 */
const test = require('node:test');
const assert = require('node:assert');
const { bumpConsoleImageTag } = require('./server');

// A faithful slice of overlays/prod/kustomization.yaml: two concrete image lines
// (initContainer + console container) plus a decoy `newTag:` that must be ignored.
const OVERLAY = `
            initContainers:
              - name: clone-infra-routes
                image: registry.int.rlservers.com/infraweaver-console:release-bf89c8ee
            containers:
              - name: console
                image: registry.int.rlservers.com/infraweaver-console:release-bf89c8ee
images:
  - name: other/thing
    newTag: should-not-change
`;

test('bumps every concrete console image: line to the new tag', () => {
  const { contents, previousTag } = bumpConsoleImageTag(OVERLAY, 'release-449cbc1a');
  assert.strictEqual(previousTag, 'release-bf89c8ee');
  const pinned = contents.match(/infraweaver-console:(\S+)/g);
  assert.deepStrictEqual(pinned, [
    'infraweaver-console:release-449cbc1a',
    'infraweaver-console:release-449cbc1a',
  ]);
  // The pin actually MOVED — the old tag is gone entirely.
  assert.ok(!contents.includes('release-bf89c8ee'), 'old tag must not remain');
  // Unrelated newTag: fields are untouched.
  assert.ok(contents.includes('newTag: should-not-change'));
});

test('is idempotent when already at the target tag', () => {
  const once = bumpConsoleImageTag(OVERLAY, 'release-449cbc1a').contents;
  const twice = bumpConsoleImageTag(once, 'release-449cbc1a').contents;
  assert.strictEqual(once, twice);
});

test('reports null previousTag when there is no console image to bump', () => {
  const { previousTag, contents } = bumpConsoleImageTag('no image here\n', 'release-x');
  assert.strictEqual(previousTag, null);
  assert.strictEqual(contents, 'no image here\n');
});
