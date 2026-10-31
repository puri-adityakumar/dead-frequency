import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'blogs/dead-frequency-ghost-in-the-machine.md');
const article = await fs.readFile(file, 'utf8');
const frontmatter = article.match(/^---\n([\s\S]*?)\n---\n/);
assert.ok(frontmatter, 'Blog needs YAML frontmatter');
assert.match(frontmatter[1], /^published:\s*false\s*$/m, 'Local draft must remain unpublished');
for (const tag of ['devchallenge', 'hf26challenge']) {
  assert.ok(frontmatter[1].match(/^tags:.*$/m)?.[0].includes(tag), `Missing required tag: ${tag}`);
}
for (const heading of ['What I Built', 'Demo', 'Code', 'How I Built It', 'Why Does Open Innovation Matter?']) {
  assert.ok(article.includes(`## ${heading}`), `Missing section: ${heading}`);
}
const links = [...article.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
const cover = frontmatter[1].match(/^cover_image:\s*(.+)$/m)?.[1];
if (cover) links.push(cover.replace(/^["']|["']$/g, ''));
const localLinks = [...new Set(links.filter((link) => !/^(?:https?:|#|mailto:)/.test(link)))];
for (const link of localLinks) {
  assert.ok(!path.isAbsolute(link), `Blog should use portable relative paths: ${link}`);
  const asset = path.resolve(path.dirname(file), link);
  assert.ok(asset.startsWith(path.join(root, 'blogs') + path.sep), `Asset escapes blogs directory: ${link}`);
  const stat = await fs.stat(asset).catch(() => null);
  assert.ok(stat?.isFile() && stat.size > 0, `Missing or empty asset: ${link}`);
  if (link.endsWith('.png')) {
    const data = await fs.readFile(asset);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Not a PNG: ${link}`);
    assert.ok(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0, `Invalid PNG dimensions: ${link}`);
  }
  if (link.endsWith('.mp4')) {
    const handle = await fs.open(asset, 'r');
    try {
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      assert.equal(header.toString('ascii', 4, 8), 'ftyp', `Invalid MP4 header: ${link}`);
    } finally {
      await handle.close();
    }
  }
}
const remaining = article.split('\n').filter((line) => /TODO|public URL pending|not chosen a license/.test(line));
console.log(`PASS: unpublished blog frontmatter, required sections/tags, and ${localLinks.length} local asset references.`);
console.log(`Draft length: ${article.trim().split(/\s+/).length} words including frontmatter.`);
if (remaining.length) {
  console.log('Publication reminders (not local draft failures):');
  for (const line of remaining) console.log(`- ${line}`);
}
