# Candidate

## 1. Years in a senior or lead role, and your primary stack today

I have **2 years of experience in a senior role**.


My primary stack today is **React, Next.js, and TypeScript** on the frontend, with **TypeScript, and PostgreSQL** for backend development.

## 2. One or two production systems

**7EDGE client web app (React / Next.js):**
I owned the frontend end-to-end, including application pages, API integration, authentication-gated flows, and Jest/Cypress test coverage. The application handled **a few hundred concurrent users** and approximately **tens of requests per second** during busy periods.

**Codezyng web/mobile products:**
I have worked end-to-end on customer-facing TypeScript applications, from UI implementation through API integration and feature delivery. These systems typically handled **hundreds of concurrent users** and **low tens of requests per second per environment**. I have not worked on a payments system operating at 100+ requests/second, so I would rather provide the actual scale I have experienced than overstate it.

## 3. Current notice period and target salary range

**Notice period:** 30 days
**Target salary:** ₹10 LPA – ₹15 LPA

## 4. One recent technical decision you’d make differently

I would avoid implementing idempotency as a simple “SELECT by key, then INSERT” pattern on a connection pool. That check is not sufficient when two retries arrive concurrently, because both requests can observe no existing record before either one inserts. The reliable approach is a **unique constraint on the caller and idempotency key, enforced within the same transaction as the balance updates**. I intentionally used that approach in this submission.

## 5. How many hours you actually spent on this exercise

Approximately **1 hour on the build and tests, and 20 minutes on the written section**.
