DocsToData — A Local-first Agentic Document Intelligence Platform with MCP Integration.

Phase 1 · UI Revamp

- Revamp existing UI
- GSAP Support
- Fancy animation and transition
- Typography design

- Main chat (which support user to add # to call different tools, such as #compare, #plan, #action) | History data (calendar) | Settings (Languages | Profile | Currency)
- The main chat could support files upload for quotation, PO, Invoice; and each of them should help do with different task.

For example:

- Quotation supports with #compare, to identify which vendor is better and why.
- PO and Invoice supports with data extraction, summary and file saving to certain path of S3 with specific folder name.

Phase 2 · Core MVP
Document → Structured Data → Excel

- 复用现有 FAISS RAG。
- 支持 PDF Invoice Extraction。
- Pydantic Schema Validation。
- Local MCP Server。
- Excel Create / Read / Append。
- AWS S3 create/edit/delete

Phase 3 · Agent Workflow
Multi-step Document Agent

- 多文件批量提取。
- Duplicate Detection。
- Human Approval。
- DOCX Report Generation。
- Tool Execution Logs。
- Evaluation Benchmark。

Phase 4 · Productization
Multi-client MCP Platform

- Claude Desktop Integration。
- Claude Code Integration。
- Custom Agent Client。
- Local Workspace Management。
- MCP Authentication / Permissions。
- Plugin-style Tool Extension。
