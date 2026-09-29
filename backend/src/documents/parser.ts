// Standalone, short-lived document parser. Never evaluates document scripts.
process.once("message", async ({ base64, extension }: { base64: string; extension: string }) => {
  try {
    const buffer = Buffer.from(base64, "base64");
    let text: string;
    if (extension === "pdf") {
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Tệp PDF không hợp lệ.");
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try { text = (await parser.getText()).pages.map((page) => page.text).join("\n"); } finally { await parser.destroy(); }
    } else if (extension === "docx") {
      // Bound the ZIP expansion before handing it to Mammoth. Reject ZIP64.
      let end = -1;
      for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
      }
      if (end < 0) throw new Error("Tệp DOCX không hợp lệ.");
      const entries = buffer.readUInt16LE(end + 10);
      let offset = buffer.readUInt32LE(end + 16), expanded = 0;
      if (entries > 1000) throw new Error("Tệp DOCX quá phức tạp. Hãy xuất sang TXT.");
      for (let i = 0; i < entries; i++) {
        if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Tệp DOCX không hợp lệ.");
        expanded += buffer.readUInt32LE(offset + 24);
        if (expanded > 20 * 1024 * 1024) throw new Error("Nội dung DOCX quá lớn. Hãy chia nhỏ tài liệu.");
        offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
      }
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (text.includes("\0")) throw new Error("Tệp không phải văn bản UTF-8.");
    }
    text = text.trim();
    if (text.length < 2) throw new Error("Không tìm thấy nội dung chữ. PDF scan cần chuyển thành văn bản trước khi gửi.");
    if (text.length > 60000) throw new Error("Tài liệu vượt quá 60.000 ký tự. Hãy chia nhỏ trước khi gửi.");
    process.send?.({ text });
  } catch (error) {
    process.send?.({ error: error instanceof Error && /[À-ỹ]/.test(error.message) ? error.message : "Không đọc được tài liệu. Hãy kiểm tra tệp hoặc xuất sang TXT." });
  } finally { process.disconnect(); }
});
