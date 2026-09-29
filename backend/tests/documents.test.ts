import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { extractAttachment, referenceHistory, MAX_FILE_BYTES } from '../src/documents/index.js';

const input = (name: string, text: string | Buffer) => ({ name, base64: Buffer.from(text).toString('base64') });

test('extracts UTF-8 Vietnamese text without executing markup', async () => {
  const doc = await extractAttachment(input('hướng dẫn.md', 'Sửa tên khách hàng. <script>alert(1)</script>'));
  assert.equal(doc.text, 'Sửa tên khách hàng. <script>alert(1)</script>');
  assert.equal(doc.name, 'hướng dẫn.md');
});

for (const extension of ['docx', 'pdf']) {
  test(`extracts actual ${extension} documents in the isolated parser`, async () => {
    const bytes = await readFile(new URL(`./fixtures/instructions.${extension}`, import.meta.url));
    const doc = await extractAttachment(input(`instructions.${extension}`, bytes));
    assert.match(doc.text, extension === 'pdf' ? /Install from official source/ : /Điền tên khách hàng/);
  });
}

test('rejects invalid, unsupported, empty, oversized and unreadable documents', async () => {
  for (const file of [input('file.exe', 'hello'), input('file.txt', ''), input('file.txt', Buffer.alloc(MAX_FILE_BYTES + 1)), input('file.pdf', 'not a PDF'), input('file.docx', 'not a ZIP'), input('file.txt', Buffer.from([0xff, 0xfe])), input('file.txt', 'x'.repeat(60001)), { name: 'file.txt', base64: '!invalid!' }, input('../file.txt', 'hello')]) {
    await assert.rejects(extractAttachment(file));
  }
});

test('rejects DOCX with excessive declared expansion before decompressing', async () => {
  const bytes = await readFile(new URL('./fixtures/instructions.docx', import.meta.url));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(100 * 1024 * 1024, central + 24);
  await assert.rejects(extractAttachment(input('bomb.docx', bytes)), /quá lớn/);
});

test('keeps newest complete document and explicitly marks omitted context', () => {
  const messages = ['old', 'new'].map(name => ({ author_type: 'user', body: name, attachments: [{ name, size: 60000, text: name.repeat(20000) }] }));
  const context = referenceHistory(messages);
  assert.equal(context.length, 2);
  assert.match(context[0].content, /omitted/);
  assert.match(context[1].content, /Reference document "new"/);
  assert.ok(context.map(m => m.content).join('').length < 100300);
});
