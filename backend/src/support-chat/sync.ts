// Pushes the support bot's persona and the user-facing docs to the SchoolsAI
// workspace. Re-run after editing any file in KNOWLEDGE_FILES:
//   SCHOOLSAI_API_KEY=sk_... npm run support-chat:sync
// Only documents whose title starts with KNOWLEDGE_PREFIX are replaced, so
// anything added by hand in the SchoolsAI dashboard is left alone.
import { readFile } from "node:fs/promises";
import { addKnowledge, deleteKnowledge, listKnowledge, patchConfig } from "./schoolsai.js";

const KNOWLEDGE_PREFIX = "itsupport:";
const KNOWLEDGE_FILES = [
  { title: "Tổng quan hệ thống AI IT Support", path: "../docs/TONG_QUAN_HE_THONG.md" },
  { title: "Hướng dẫn sử dụng IT Support", path: "../docs/HUONG_DAN_SU_DUNG.md" },
  { title: "Gói phần mềm và nhiệt độ trên Linux", path: "../docs/linux-packages.md" },
];

const SYSTEM_PROMPT = `Bạn là trợ lý hỗ trợ của nền tảng AI IT Support (https://itsupport.schoolsai.work) — dịch vụ AI chẩn đoán và xử lý sự cố máy tính Windows, macOS, Linux có con người phê duyệt mọi thao tác thay đổi máy.

Cấp 1 (mặc định): tư vấn chung về toàn bộ hệ thống — tính năng, cách đăng ký, thêm máy, luồng ticket/phê duyệt, hỗ trợ từ xa, xử lý lỗi cài agent. Trả lời dựa trên tài liệu trong knowledge base; nếu tài liệu không có thì nói rõ là chưa có thông tin, không bịa. Ở cấp này bạn KHÔNG có dữ liệu riêng của khách; khi người dùng hỏi về máy/ticket cụ thể của họ, hướng dẫn họ đăng nhập và chuyển sang tab "Tài khoản của tôi".

Cấp 2: khi tin nhắn bắt đầu bằng khối [TRỢ LÝ TÀI KHOẢN — CẤP 2], hãy tuân thủ đúng giao thức công cụ trong khối đó (trả về đúng 1 dòng TOOL {...} khi cần dữ liệu) và chỉ nói về workspace được nêu.

Luôn: trả lời ngắn gọn, theo từng bước, đúng ngôn ngữ người dùng; không bao giờ yêu cầu mật khẩu, mã cài đặt hay token. Việc phê duyệt chỉ áp dụng cho thao tác do AI đề xuất trong ticket; người dùng tự cài/cài lại agent hay tự thao tác trên máy của mình thì không cần phê duyệt — đừng thêm lưu ý phê duyệt cho các bước đó.`;

async function main() {
  await patchConfig({
    bot_name: "Trợ lý IT Support",
    greeting: "Xin chào! Mình là trợ lý IT Support. Bạn cần hỗ trợ gì?",
    system_prompt: SYSTEM_PROMPT,
    response_language: "auto",
    temperature: 0.3,
  });
  console.log("config updated");

  for (const doc of await listKnowledge()) {
    if (doc.title?.startsWith(KNOWLEDGE_PREFIX)) {
      await deleteKnowledge(doc.id);
      console.log(`removed ${doc.title}`);
    }
  }
  for (const file of KNOWLEDGE_FILES) {
    const text = await readFile(new URL(`../../${file.path}`, import.meta.url), "utf8");
    await addKnowledge(`${KNOWLEDGE_PREFIX} ${file.title}`, text);
    console.log(`uploaded ${file.title} (${text.length} chars)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
