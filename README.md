# 🧠 Neural Knowledge Base MCP Server & Studio

> **Local Neural Knowledge Graph & Architecture Intelligence Platform**  
> Giải pháp đồ thị tri thức ngữ nghĩa cục bộ cho AI Coding Agents (Claude, Cursor, Windsurf, Cline, Antigravity). Giúp Agent đọc hiểu toàn bộ kiến trúc dự án, tra cứu thư viện và đánh giá tác động thay đổi với **tốc độ < 5ms**, **tiết kiệm 85% – 95% token context**, và **độ chính xác 100% không ảo giác**.

---

## 📌 Mục Lục
1. [Giới Thiệu Tổng Quan](#1-giới-thiệu-tổng-quan)
2. [Các Khả Năng Cốt Lõi (Core Capabilities)](#2-các-khả-năng-cốt-lõi-core-capabilities)
3. [Hiệu Quả Thực Tế & Đo Lường ROI (Benchmark)](#3-hiệu-quả-thực-tế--đo-lường-roi-benchmark)
4. [Hướng Dẫn Tương Tác Bằng Ngôn Ngữ Tự Nhiên](#4-hướng-dẫn-tương-tác-bằng-ngôn-ngữ-tự-nhiên)
5. [Bảng Tra Cứu Toàn Bộ 17 Công Cụ MCP](#5-bảng-tra-cứu-toàn-bộ-17-công-cụ-mcp)
6. [Quản Lý Thư Viện Bên Thứ Ba & Cơ Chế Cắt Tỉa](#6-quản-lý-thư-viện-bên-thứ-ba--cơ-chế-cắt-tỉa)
7. [Tích Hợp Vào Các AI Clients (1-Click & Config)](#7-tích-hợp-vào-các-ai-clients)
8. [Giao Diện Đồ Họa: Neural Knowledge Studio (Web UI)](#8-giao-diện-đồ-họa-neural-knowledge-studio-web-ui)

---

## 1. Giới Thiệu Tổng Quan

### Vấn Đề Lớn Của AI Coding Assistant Hiện Nay
- **Tràn context window & đắt đỏ**: Khi bắt đầu một phiên làm việc, Agent thường chạy hàng loạt lệnh `grep`, `glob`, hoặc đọc mù quáng hàng chục file mã nguồn lớn. Một câu hỏi đơn giản có thể tiêu tốn **30.000 – 100.000 tokens**.
- **Mất bối cảnh kiến trúc**: Đọc từng file rời rạc khiến Agent không thấy được bức tranh tổng thể (Big Picture): module nào gọi module nào, quy tắc kiến trúc ra sao, sửa đổi một chỗ sẽ kéo theo hỏng hóc ở đâu.
- **Bất lực với thư viện bên thứ 3**: Khi dự án sử dụng các framework như `flutter_bloc`, `go_router`, `objectbox`, Agent thường phải đoán mò hoặc tra web (dễ dính breaking changes của phiên bản mới).

### Giải Pháp: Neural Knowledge Base
**Neural Knowledge Base MCP** biến toàn bộ codebase, tài liệu nghiệp vụ (PDF, Word, Markdown) và thư viện phụ thuộc thành một **Sơ đồ Neuron Ngữ nghĩa (Knowledge Graph)** được lưu trữ cục bộ:
- **Zero-Copy In-Memory Engine**: Cache đồ thị trên RAM cho phép duyệt 360 độ và phân tích tác động dây chuyền trong **< 5 miligiây**.
- **SQLite WAL + FTS5 Full-Text Search**: Tìm kiếm toàn văn siêu tốc với thuật toán BM25 có trọng số.
- **Tiết kiệm đến 95% token**: Thay vì nạp cả ngàn dòng code, Agent chỉ nhận sơ đồ Mermaid hoặc các trích đoạn neuron trọng yếu (~250 tokens).

---

## 2. Các Khả Năng Cốt Lõi (Core Capabilities)

```mermaid
flowchart LR
    A["Mã Nguồn / Docs / 3rd-Party Libs"] --> B["Extractor & Parsers"]
    B --> C[("SQLite + FTS5\nWAL Mode")]
    C --> D["In-Memory Graph Cache\n(< 5ms Traversal)"]
    D --> E["MCP Server (17 Tools)"]
    D --> F["Web Studio (vis-network 60fps)"]
    E --> G["AI Agents (Claude / Cursor / Antigravity)"]
```

### 1. Khám Phá Kiến Trúc Đa Tầng (LOD Architectural Topology)
- Tự động dựng sơ đồ **Mermaid** trực quan về cấu trúc dự án.
- Hỗ trợ **Level of Detail (LOD)**: LOD 0 hiển thị các Hubs vĩ mô cấp hệ thống, LOD 1 hiển thị chi tiết các module liên kết.
- Nhận diện các **Architectural Hubs** (trung tâm điều phối huyết mạch) bằng thuật toán phân tích kết nối Graph Centrality.

### 2. Phân Tích Tác Động Dây Chuyền (Blast Radius & Impact Analysis)
- Khi chuẩn bị refactor, đổi kiểu dữ liệu, hoặc xoá một Service/API/Entity, công cụ `kb_graph_impact` duyệt ngược toàn bộ đồ thị để tìm tất cả các module, màn hình, luồng nghiệp vụ và bài test bị ảnh hưởng.
- Ngăn chặn triệt để lỗi hồi quy (regression bugs) trước khi gõ phím viết code.

### 3. Tìm Kiếm Ngữ Nghĩa Chính Xác Kèm Dẫn Chứng Nguyên Văn (Provenance)
- Thuật toán tìm kiếm BM25 kết hợp từ điển đồng nghĩa tiếng Việt/tiếng Anh và loại bỏ nhiễu từ các file test/mock.
- Trả về vị trí chính xác `path/to/file.dart:line` và trích xuất code ngắn (khi dùng `code=12`), loại bỏ hoàn toàn nhu cầu đọc file nối tiếp.
- Cam kết **100% không ảo giác**: Mỗi neuron đều gắn chặt với file nguồn, số trang PDF, hoặc điều khoản quy định.

### 4. Tự Động Định Vị & Nạp Thư Viện Bên Thứ Ba (Self-Expanding 3rd-Party Libs)
- Tự động soi `pubspec.lock` (Dart/Flutter) hoặc `package.json` (Node.js) để tìm chính xác phiên bản đang dùng trong máy (`.pub-cache` hoặc `node_modules`).
- Tự động tạo đồ thị riêng cho thư viện (`lib-<name>-<version>`), nạp mã nguồn, và bắc cầu liên kết chéo (`project_links`).
- Khi tìm kiếm từ dự án chính, hệ thống tự động tìm xuyên suốt cả app lẫn thư viện.
- Smart Redirection: Phát hiện truy vấn liên quan đến thư viện chưa nạp và hướng dẫn Agent cách xử lý trong 1 click.

### 5. Cắt Tỉa Rác & Thu Hồi Dung Lượng Ổ Cứng (Garbage Collection & Pruning)
- Cơ chế 4 tầng bảo vệ phát hiện thư viện mồ côi (không còn project nào trỏ tới) hoặc mã nguồn đã bị xoá khỏi máy.
- Xoá thác đổ (Cascading Delete) và tự động kích hoạt **SQLite VACUUM** để thu hồi dung lượng vật lý trên ổ cứng.

### 6. Khả Năng Tự Học (Proactive Knowledge Retention)
- Cho phép Agent lưu lại các quy ước kỹ thuật, quyết định thiết kế (ADR), hoặc chính sách nghiệp vụ mới phát sinh trong quá trình chat vào thẳng đồ thị để dùng vĩnh viễn cho các phiên làm việc sau.

### 7. Giám Sát & Báo Động Lỗ Hổng Kiến Thức (Gap Audit)
- Tự động phát hiện các liên kết gãy (dangling references): tài liệu có nhắc đến một API/quy trình nhưng chưa nạp file định nghĩa.

---

## 3. Hiệu Quả Thực Tế & Đo Lường ROI (Benchmark)

Dữ liệu đo đạc trực tiếp từ dự án **`budgetable-v2`** (Flutter Melos Monorepo, 3.505 Nodes, 5.518 Edges):

| Tiêu Chí Đo Lường | Không Dùng KB (Đọc File Thô / Grep) | Dùng Neural Knowledge Base MCP | Mức Độ Cải Thiện |
| :--- | :--- | :--- | :--- |
| **Token đọc hiểu tổng quan** | ~50.000 tokens (đọc hàng chục file core) | **~250 tokens** (`kb_graph_overview`) | **Tiết kiệm 99.5%** |
| **Token tra cứu vị trí code** | ~120.000 tokens (grep + mở nhiều file) | **~800 tokens** (`kb_search`) | **Tiết kiệm 99.3%** |
| **Token phân tích tác động** | ~269.000 tokens (trace thủ công 269 files) | **~13.000 tokens** (`kb_graph_impact`) | **Tiết kiệm 95.2%** |
| **Tổng Token cả phiên làm việc** | **388.070 tokens** | **18.815 tokens** | **Tiết kiệm 95.2%** |
| **Độ chính xác phân tích** | Dễ sót file trong monorepo lớn | **100% precision** (269/269 dependencies) | Tuyệt đối |
| **Thời gian phản hồi P50** | Vài chục giây (I/O disk) | **3.97 ms** (In-Memory RAM) | Nhanh hơn 1000x |
| **Mức chiếm dụng RAM** | Phụ thuộc editor | **26.9 MB** | Rất nhẹ |

---

## 4. Hướng Dẫn Tương Tác Bằng Ngôn Ngữ Tự Nhiên

Agent đã được tích hợp sẵn Skill và Rule, bạn **không cần nhớ tên hàm MCP**. Hãy ra lệnh tự nhiên theo các kịch bản dưới đây:

### 🚀 Kịch bản 1: Onboarding vào dự án mới
- **Bạn nói**: *"Cho tôi xem sơ đồ kiến trúc tổng thể của dự án budgetable-v2."*
- **Agent ngầm gọi**: `kb_graph_overview(project_id="budgetable-v2", lod=0)`
- **Kết quả**: Trả về sơ đồ Mermaid trực quan, thấy ngay các phân tầng Domain, Service, Presentation và Hub huyết mạch trong ~250 tokens.

### 🔍 Kịch bản 2: Tìm hiểu một tính năng hoặc luồng code
- **Bạn nói**: *"Tìm xem logic tính toán hạn mức ngân sách và cảnh báo chi tiêu nằm ở đâu?"*
- **Agent ngầm gọi**: `kb_search(query="calculate budget progress alert", project_id="budgetable-v2", code=12)`
- **Kết quả**: Nhận chính xác file, dòng code và trích đoạn hàm xử lý mà không cần mở toàn bộ file.

### ⚠️ Kịch bản 3: Đánh giá rủi ro trước khi refactor hoặc sửa code
- **Bạn nói**: *"Nếu tôi thay đổi cấu trúc của class `Transaction` trong `budgetable_core` thì những đâu sẽ bị ảnh hưởng?"*
- **Agent ngầm gọi**: `kb_graph_impact(target_node_id="module:lib_budgetable_core_dart")`
- **Kết quả**: Báo cáo chính xác danh sách các BLoC, màn hình UI, use cases và test cases bị tác động.

### 📦 Kịch bản 4: Nghiên cứu thư viện bên thứ 3
- **Bạn nói**: *"Tôi cần hiểu cơ chế hoạt động của `flutter_bloc` trong dự án này để fix bug stream."*
- **Agent ngầm gọi**: `kb_resolve_library(project_id="budgetable-v2", library_name="flutter_bloc", auto_ingest=true)`
- **Kết quả**: Hệ thống tự tìm `.pub-cache`, nạp 10 file mã nguồn của `flutter_bloc 9.1.1` vào đồ thị `lib-flutter_bloc-9.1.1` và liên kết ngay lập tức. Sau đó Agent tra cứu API nội bộ của Bloc chỉ tốn ~200 tokens.

### 💾 Kịch bản 5: Dạy Agent ghi nhớ quy tắc dự án
- **Bạn nói**: *"Ghi nhớ: Từ nay mọi Form nhập tiền tệ bắt buộc phải format qua AmountInputFormatter và kiểm tra số dư âm."*
- **Agent ngầm gọi**: `kb_add_node(project_id="budgetable-v2", id="rule:currency_input_validation", ...)`
- **Kết quả**: Ghi vĩnh viễn vào SQLite. Các phiên làm việc sau mọi Agent đều tự động tuân thủ quy tắc này.

### 🧹 Kịch bản 6: Dọn dẹp và tối ưu bộ nhớ
- **Bạn nói**: *"Kiểm tra và cắt tỉa các thư viện không còn dùng trong knowledge base."*
- **Agent ngầm gọi**: `kb_prune_libraries(dry_run=false, vacuum=true)`
- **Kết quả**: Quét sạch các graph thư viện mồ côi và chạy VACUUM giải phóng ổ cứng.

---

## 5. Bảng Tra Cứu Toàn Bộ 17 Công Cụ MCP

| # | Tên Công Cụ | Nhóm Chức Năng | Tham Số Trọng Yếu | Mô Tả Tác Dụng |
|---|:---|:---|:---|:---|
| 1 | `kb_project_create` | Quản lý | `project_id`, `name`, `domain`, `description` | Khởi tạo không gian dự án mới kèm anchor hub. |
| 2 | `kb_project_list` | Quản lý | *(không)* | Liệt kê danh sách dự án, số node/edge và thư viện liên kết. |
| 3 | `kb_graph_overview` | Khám phá | `project_id`, `lod (0/1)`, `format` | Xuất sơ đồ Mermaid hoặc tóm tắt kiến trúc vĩ mô. |
| 4 | `kb_graph_explore` | Khám phá | `node_id`, `depth (1/2)` | Khám phá mạng lưới neuron 360° quanh một node. |
| 5 | `kb_graph_impact` | An toàn | `target_node_id` | Phân tích tác động dây chuyền khi sửa/xoá một thực thể. |
| 6 | `kb_search` | Tra cứu | `query`, `project_id`, `limit`, `code`, `max_tokens` | Tìm kiếm BM25 toàn văn trên graph và mã nguồn thô. |
| 7 | `kb_file_outline` | Tra cứu | `file_path`, `project_id` | Xem danh mục các class/hàm/dòng code của 1 file lớn. |
| 8 | `kb_node_get` | Chi tiết | `node_id`, `include_raw (true/false)` | Lấy thông tin chi tiết một node kèm trích dẫn gốc. |
| 9 | `kb_resolve_library` | Thư viện 3rd | `project_id`, `library_name`, `auto_ingest` | **MỚI**: Tự định vị cache, nạp đồ thị thư viện và liên kết. |
| 10 | `kb_prune_libraries` | Tối ưu hóa | `dry_run`, `vacuum` | **MỚI**: Cắt tỉa thư viện mồ côi và chạy SQLite VACUUM. |
| 11 | `kb_ingest_file` | Nạp dữ liệu | `project_id`, `file_path`, `domain` | Nạp 1 file đơn lẻ (Code, PDF, Word, Markdown, SQL). |
| 12 | `kb_batch_ingest_directory` | Nạp dữ liệu | `project_id`, `dir_path`, `extensions`, `ignore` | Quét nạp cả thư mục với SHA-256 delta-skipping. |
| 13 | `kb_sync` | Đồng bộ | `project_id`, `dir_path`, `ignore` | Cập nhật file sửa đổi, xoá file đã bị xoá trên đĩa. |
| 14 | `kb_add_node` | Tự học | `project_id`, `id`, `label`, `node_type`, `summary` | Thêm concept, rule, quyết định mới vào đồ thị. |
| 15 | `kb_add_relation` | Tự học | `project_id`, `source_id`, `target_id`, `relation_type` | Nối dây quan hệ giữa 2 neuron bất kỳ. |
| 16 | `kb_flag_gap` | Giám sát | `project_id`, `missing_item`, `reason` | Ghi nhận lỗ hổng kiến thức hoặc tài liệu bị thiếu. |
| 17 | `kb_audit_gaps` | Giám sát | `project_id` | Quét tìm liên kết gãy hoặc tài liệu chưa nạp. |
| 18 | `kb_stats` | Thống kê | `project_id` | Báo cáo số lượng entity, domain, Top 5 Hubs. |
| 19 | `kb_metrics` | Đo lường | `reset` | Báo cáo SLA độ trễ P50/P95, tỷ lệ % token tiết kiệm, RAM. |

---

## 6. Quản Lý Thư Viện Bên Thứ Ba & Cơ Chế Cắt Tỉa

### 1. Cơ chế cô lập phiên bản (`lib-<name>-<version>`)
Khi nhiều dự án dùng các version khác nhau:
- Dự án A (`budgetable-v2`) dùng `flutter_bloc: 9.1.1` $\rightarrow$ Trỏ tới `lib-flutter_bloc-9.1.1`.
- Dự án B (`old-app`) dùng `flutter_bloc: 8.1.3` $\rightarrow$ Trỏ tới `lib-flutter_bloc-8.1.3`.
- Bảng `project_links` đảm bảo Agent khi làm việc ở dự án nào **chỉ nhìn thấy đúng API của phiên bản dự án đó**.

### 2. Chu kỳ thu dọn rác (Garbage Collection)
```
[Dự án gỡ bỏ thư viện] → [Thư viện thành mồ côi (0 liên kết)]
                                      ↓
                              kb_prune_libraries()
                                      ↓
             [Xoá Nodes + Edges + Sources + FTS Index]
                                      ↓
                      [SQLite VACUUM thu hồi dung lượng đĩa]
```

---

## 7. Tích Hợp Vào Các AI Clients

Hệ thống hỗ trợ chạy trực tiếp cục bộ qua Node.js:

### 1. Claude Desktop
Chỉnh sửa file `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": [
        "/Volumes/Data/station/personal/projects/knowledge_base/dist/index.js"
      ],
      "env": {
        "KB_DB_PATH": "/Volumes/Data/station/personal/projects/knowledge_base/data/neural_knowledge.db"
      }
    }
  }
}
```

### 2. Cursor IDE
Vào **Settings** $\rightarrow$ **Features** $\rightarrow$ **MCP Servers** $\rightarrow$ **+ Add New MCP Server**:
- Name: `knowledge-base`
- Type: `command`
- Command: `node /Volumes/Data/station/personal/projects/knowledge_base/dist/index.js`

### 3. VS Code (Cline / Roo Code)
Mở cấu hình MCP trong panel Cline:
```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["/Volumes/Data/station/personal/projects/knowledge_base/dist/index.js"],
      "disabled": false,
      "autoApprove": [
        "kb_graph_overview",
        "kb_graph_explore",
        "kb_search",
        "kb_node_get",
        "kb_file_outline",
        "kb_resolve_library"
      ]
    }
  }
}
```

### 4. Tùy Chọn Tiết Kiệm Khai Báo Tool
Nếu muốn tiết kiệm tối đa token khai báo công cụ ban đầu cho Agent:
- Đặt biến môi trường `KB_TOOLSET=read`: Hệ thống chỉ nạp 10 công cụ đọc cốt lõi (~690 tokens thay vì ~1.600 tokens).

---

## 8. Giao Diện Đồ Họa: Neural Knowledge Studio (Web UI)

Bên cạnh giao diện dòng lệnh MCP, dự án tích hợp sẵn **Web Studio** hiện đại xây dựng trên Next.js và Tailwind/shadcn:

```bash
# Khởi động đồng thời cả Web Studio (port 3000) và REST Bridge (port 4242)
npm run web
```

### Các Tính Năng Nổi Bật Trên Giao Diện:
1. **Interactive Physics Graph (vis-network 60fps)**: Sơ đồ mạng nơ-ron tương tác mượt mà, đổi màu theo Domain, zoom theo tầng LOD.
2. **Slide-over Inspector**: Bấm vào bất kỳ node nào để xem quan hệ vào/ra và nút soi dẫn chứng nguyên văn.
3. **Multi-Modal Ingest Zone**: Kéo thả trực tiếp file PDF, Word, Markdown, Code vào dự án.
4. **Knowledge Gap Kanban**: Bảng Kanban 2 cột quản lý và giải quyết các lỗ hổng tri thức.
5. **Telemetry & ROI Dashboard**: Biểu đồ trực quan hóa số lượng token đã tiết kiệm qua từng phiên làm việc.

---

## 📄 Bản Quyền & Giấy Phép
Dự án được phát triển và vận hành cục bộ (100% Local-First). Dữ liệu của bạn được bảo mật tuyệt đối trên máy tính cá nhân, không gửi dữ liệu ra máy chủ bên ngoài.
