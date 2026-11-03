# Kế hoạch tối ưu (giao cho Gemini)

Phạm vi: tốc độ ingest/re-index và chi phí đồng bộ cache. Không đổi hành vi công khai của 21 MCP tools.
Đã đánh giá bằng đọc code, **chưa đo**. Bước 0 là bắt buộc để có số liệu trước/sau.

## Quy tắc chung
- Mỗi bước là một commit riêng, chạy `npm run build` và selftest (`src/selftest.ts`) trước khi sang bước sau.
- Working tree đang có nhiều file sửa dở (`graph_memory.ts`, `code_parser.ts`, `query_tools.ts`...). Commit hoặc stash phần của chủ repo trước, đừng trộn vào commit tối ưu.
- Trước khi sửa symbol nào, chạy `kb_graph_impact`. Sau khi sửa, chạy `kb_sync`.
- Không thêm dependency. Không đổi schema ngoài index được nêu ở bước 5.

## Bước 0 — Đo baseline
Ingest repo này bằng `kb_batch_ingest_directory` (force=false, chạy 2 lần liên tiếp). Ghi lại: thời gian lần 1, thời gian lần 2 (toàn file không đổi), RAM sau hydrate, thời gian `syncIfStale`. Lưu số vào cuối file này.

## Bước 1 — Bỏ qua file không đổi TRƯỚC khi parse (lợi nhất)
`src/tools/ingestion_tools.ts` ~dòng 253-259: `extractFromFile` (đọc + parse + trích xuất) chạy xong mới so `file_hash`, nên lần re-index nào cũng parse lại toàn bộ.
- Tính hash nội dung (hoặc so `mtime+size` lưu cùng hash) trước, so với `checkFileHashStmt`, nếu trùng và `!force` thì `skipped++; continue` mà không gọi extractor.
- Cần tách phần tính hash khỏi `knowledgeExtractor.extractFromFile` (xem `src/engine/parsers/extractor.ts`) và dùng đúng cùng thuật toán hash để không làm vô hiệu hash cũ trong DB.
- Kiểm tra: lần ingest thứ 2 phải nhanh hơn rõ rệt, kết quả `Skipped` không đổi.
- Làm tương tự cho đường `watcher.ts` và `kb_ingest_file` nếu chúng có cùng mẫu.

## Bước 2 — Bỏ O(N) mỗi file trong `persistExtraction`
`src/engine/persist.ts` dòng 79-142. Mỗi file ingest gọi `graphMemory.getProjectNodes(projectId)` (cấp phát mảng toàn bộ node project) rồi quét lặp → ingest cả repo là O(N²).
- Thêm vào `GraphMemoryCache` hai index nhỏ, cập nhật trong `addNodeMemory`/`removeNode`: `nodesByFile: Map<file_path, Set<nodeId>>` và `importersOf: Map<moduleId, Set<file_path>>` (từ `internal_imports` của node module).
- Thay vòng quét `existingProjectNodes` (tìm symbol đã import, tìm file importer, tìm caller) bằng tra index.
- Thay `nodeExistsStmt.get(id)` (1 query DB mỗi callee) bằng `graphMemory.getNode(id)`. Lưu ý trong transaction chưa commit, node mới của chính file này chưa vào cache, nên tra thêm `result.nodes`.
- Thay vòng `owned.get(n.id, projectId)` (1 query mỗi node, dòng 20-22) bằng một `SELECT id FROM graph_nodes WHERE id IN (...) AND project_id != ?` theo lô, hoặc `graphMemory.getNode(id)?.project_id`.
- Kiểm tra: tập edge CALLS sinh ra phải **giống hệt** trước/sau (so `SELECT count(*), relation_type FROM graph_edges GROUP BY 2` và hash danh sách edge trên repo này).

## Bước 3 — Một transaction cho cả batch
`persistExtraction` tự `BEGIN`/`COMMIT` mỗi file. Với batch hàng nghìn file, gom thành transaction lớn (ví dụ mỗi 50 file) bằng SAVEPOINT thay vì BEGIN lồng nhau (BEGIN lồng sẽ lỗi).
- Giữ nguyên quy tắc hiện có: cache chỉ cập nhật sau COMMIT thật. Với SAVEPOINT, cập nhật cache sau khi transaction ngoài commit, hoặc hoàn tác cache nếu rollback.
- Rủi ro: rollback một file không được làm mất cả lô. Dùng `SAVEPOINT` / `ROLLBACK TO` theo từng file.

## Bước 4 — Giảm chi phí `syncIfStale` / `hydrate`
`src/engine/graph_memory.ts` dòng 28-46. Mỗi khi `data_version` đổi, `readSignature` chạy `COUNT(*)` hai bảng và `MAX(updated_at)` (không có index trên `updated_at` nên quét toàn bảng).
- Thêm `CREATE INDEX IF NOT EXISTS idx_nodes_updated ON graph_nodes(updated_at)`; hoặc thay chữ ký bằng một bảng `kb_meta(change_counter)` do trigger tăng (chính xác hơn, vì chữ ký hiện tại bỏ sót thay đổi cạnh mà số lượng cạnh không đổi).
- `hydrate` đọc `SELECT *` kèm `properties` (chứa mảng `calls`, `internal_imports` cho mọi node). Giữ nguyên nếu đo RAM ổn; nếu lớn, chỉ parse `properties` lười khi cần.
- `invalidateCentrality` có nhánh thừa (`delete("__all__")` rồi `clear()`); gộp lại. PageRank đã tính lười khi đọc, đừng tính lại trong lúc ingest.

## Bước 5 — Nhỏ, rủi ro thấp
- `getImpactSubgraph` (graph_memory.ts ~dòng 331): `queue.shift()` là O(n); dùng con trỏ đầu hàng đợi. Sắp xếp `inbound` mỗi lần duyệt: tách CALLS/không-CALLS bằng hai lượt thay vì sort.
- `ingestion_tools.ts` dòng 215/232: `validExts.includes` đổi sang `Set`; gọi `statSync` chỉ khi đã qua kiểm tra đuôi file (đã đúng), thay bằng `entry`-based nếu có thể.
- `nodes_fts` đang index cột `properties` (JSON có `calls`, imports), phình index và làm nhiễu bm25 (trọng số 0.2). **Chỉ đề xuất, không tự làm**: nếu bỏ cột này thì phải đo chất lượng `kb_search` trên bộ truy vấn trong selftest, vì đổi sẽ đổi xếp hạng.
- Kiểm tra `EXPLAIN QUERY PLAN` cho các truy vấn trong `query_tools.ts` (dòng ~250 FTS, ~372 raw_sources) và truy vấn `graph_edges WHERE project_id`; thêm index chỉ khi plan cho thấy full scan.

## Ngoài phạm vi / không làm
- Không viết lại parser (`code_parser.ts` đang sửa dở, nhiều rủi ro hồi quy).
- Không đổi tokenizer FTS hay trọng số `BM25` nếu chưa có số liệu chất lượng.
- Không song song hoá `persistExtraction` (SQLite một writer); chỉ có thể song song hoá phần parse, và chỉ sau khi bước 1-3 xong và đo lại.

## Tiêu chí hoàn thành
- Ingest lần 2 (không đổi file) nhanh hơn ít nhất 5 lần so với baseline.
- Ingest lần 1 nhanh hơn rõ rệt trên repo đủ lớn; không còn thời gian tăng theo bình phương số file.
- Số node, số cạnh theo từng `relation_type` và kết quả `kb_search`/`kb_graph_impact` trong selftest giống hệt baseline.
- Số liệu trước/sau ghi ở dưới.

## Số liệu
Baseline (Claude đo trước khi tối ưu, DB tạm, `kb_batch_ingest_directory`, force=false):

| Repo | Files | Cold | Lần 2 (không đổi) | Hydrate | Nodes / Edges | RSS |
|---|---|---|---|---|---|---|
| knowledge_base/src | 31 | 86ms | 35ms | 2ms | 417 / 863 | 127MB |
| budgetable_v2/lib (Dart) | 319 | 1344ms | 621ms | 28ms | 5582 / 12088 | 257MB |

`syncIfStale` khi không đổi: ~0.02-0.05ms. Chi phí mỗi file: 2.8ms (31 file) → 4.2ms (319 file).

(Gemini điền số sau tối ưu bên dưới)
