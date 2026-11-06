# ZenithCore FMIS – Data migration loaders

Legacy data arrives as CSV files (UTF-8; a byte-order mark is accepted). The loader validates every row, reports each error with its line number and field, and loads **all or nothing**.

```bash
npm run load -- budget samples/budget_lines.csv           # dry run: reports, changes nothing
npm run load -- budget samples/budget_lines.csv --commit  # loads if, and only if, there are no errors
npm run load -- employees samples/employees.csv --commit
```

| Kind | Columns | Main checks |
|---|---|---|
| `budget` | id, year, ministry_id, spending_unit_id, fund, economic, functional, programme, name_en, name_ar, name_fr, allotment | line ID format, known ministry and spending unit, classification codes, Arabic name present, amount format, no duplicates |
| `employees` | employee_no, national_id, full_name_ar, ministry_id, position_id, monthly_net | employee number format, 11-digit national ID, Arabic name, known ministry, positive amount, no duplicates |

Re-running a load updates existing records (same key) instead of duplicating them. Each committed load is written to the audit trail. Recommended sequence for a migration rehearsal: dry run → fix at source → dry run clean → commit → `npm run verify:db` → reconcile totals with the legacy system's control totals.
