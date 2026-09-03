# Candidate

Questions 1–3 are employment details. Replace the placeholders before you send this. Questions 4–5 are written against this submission.

## 1. Years in a senior or lead role, and your primary stack today

**[FILL IN: years in senior/lead, and your primary stack.]**

This exercise is implemented in TypeScript, Node.js, and PostgreSQL — the stack I would use to ship a service like this today.

## 2. One or two production systems

**[FILL IN: for each system — what you owned end-to-end, and peak concurrent users or requests/sec.]**

Example shape (replace with your own): an HTTP payments/ledger API you owned from schema through on-call, peak N req/s; a marketplace or payroll disbursement path you owned, peak N concurrent users.

## 3. Current notice period and target salary range

**[FILL IN: notice period, and target salary range with currency.]**

## 4. One recent technical decision you’d make differently

I would not ship idempotency as “SELECT by key, then INSERT” on a connection pool. That check is a hint, not a guarantee, and it fails the first time two retries overlap. The source of truth has to be a unique constraint taken in the same transaction as the balance updates. That is the mistake I have seen look fine in staging and then double-post in production; this API is built the other way on purpose.

## 5. How many hours you actually spent on this exercise

About 1 hour on the build and tests, about 20 minutes on the written section.
