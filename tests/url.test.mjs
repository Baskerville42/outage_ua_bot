import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidOutageImageUrl } from '../src/utils/url.mjs';

const oldRoot = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/refs/heads/main/images/';
const newRoot = 'https://raw.githubusercontent.com/uapowerguardkit/outage-data-ua/refs/heads/main/images/';
const imagePath = 'kyiv/gpv-3-2-emergency.png';

test('accepts existing personal-account image URLs', () => {
  assert.equal(isValidOutageImageUrl(oldRoot + imagePath), true);
});

test('accepts organization image URLs after the repository transfer', () => {
  assert.equal(isValidOutageImageUrl(newRoot + imagePath), true);
});

test('preserves case-insensitive PNG extensions for both repository roots', () => {
  for (const root of [oldRoot, newRoot]) {
    assert.equal(isValidOutageImageUrl(root + 'kyiv/gpv-3-2.PNG'), true);
  }
});

const rejected = [
  ['HTTP', newRoot.replace('https:', 'http:') + imagePath],
  ['lookalike hostname', newRoot.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.example.com') + imagePath],
  ['hostname in credentials', newRoot.replace('raw.githubusercontent.com/', 'raw.githubusercontent.com@example.com/') + imagePath],
  ['different owner', newRoot.replace('/uapowerguardkit/', '/other-owner/') + imagePath],
  ['owner prefix', newRoot.replace('/uapowerguardkit/', '/uapowerguardkit-extra/') + imagePath],
  ['different repository', newRoot.replace('/outage-data-ua/', '/other-repo/') + imagePath],
  ['repository prefix', newRoot.replace('/outage-data-ua/', '/outage-data-ua-extra/') + imagePath],
  ['different branch', newRoot.replace('/refs/heads/main/', '/refs/heads/dev/') + imagePath],
  ['different directory', newRoot.replace('/images/', '/data/') + imagePath],
  ['directory prefix', newRoot.replace('/images/', '/images-extra/') + imagePath],
  ['non-PNG file', newRoot + 'kyiv/schedule.json'],
  ['query string', newRoot + imagePath + '?cb=123'],
  ['fragment', newRoot + imagePath + '#preview'],
  ['malformed input', 'not a URL'],
  ['empty input', ''],
  ['null input', null],
  ['undefined input', undefined],
  ['array input', [oldRoot + imagePath]],
];

for (const [label, value] of rejected) {
  test(`rejects ${label}`, () => {
    assert.equal(isValidOutageImageUrl(value), false);
  });
}
