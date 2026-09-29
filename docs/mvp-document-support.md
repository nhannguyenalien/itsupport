# Chat-driven support MVP

Customers can attach one PDF (text-based), DOCX, TXT or MD per chat message. Maximum 5 MB and 60,000 extracted characters. Only extracted text is retained in ticket messages; original files are not stored. The UI discloses AI processing. Parsing runs in a short-lived child process with a 256 MB V8 heap limit, 15-second deadline and two-parser concurrency cap. Scanned PDFs require text conversion; OCR is not included.

The normal chat runs the existing diagnostic/remediation workflow. Customers select “Thao tác web/màn hình” to start the existing screenshot-driven desktop agent. No browser extension is required for this mode. A connected agent with a heartbeat within 90 seconds is required. An extension could later provide DOM-based targeting and structured form verification.

Screen sessions advance while the ticket page remains open, survive page reloads, and stop after 20 minutes or 40 dispatched actions. Closing the page stops future polling, but an in-flight request can still complete. “Dừng phiên” marks the session immediately; already queued device actions may finish. Device-scoped database locks serialize AI requests across tabs and tickets. Existing tenant tool permissions and approvals still apply. Model safety warnings end the session for technician review.

Recent chat plus document context is bounded; long or old instructions may need to be resent. Documents are reference data, never permission to override policy. The existing diagnostic tool allowlist still limits supported fixes and software installation. The model must verify results, and missing information must be requested in chat.

## Release verification

Automated tests cover real PDF/DOCX extraction, Vietnamese text, invalid/oversized documents, excessive DOCX expansion, bounded context, authentication and execution lock contention/release. Build backend and frontend, then run backend tests and CI agent checks.

Before opening this service to general Windows customers, complete an end-to-end trial on a real Windows machine: enrollment, fresh heartbeat, screenshot, browser form edit from a document, approval/rejection, software installation through supported tools, stop during a pending action, reconnect, and verification of the final result. UAC/secure desktop and human takeover require separate validation; MeshCentral fallback requires configured infrastructure. This release does not certify those scenarios.
