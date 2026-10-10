---
description: Mandatory workflow for production readiness phases (Learn -> Q&A -> Signal -> Build -> Prove)
globs: ["fixes/**", "load-tests/**", "*"]
---

# Production Readiness Workflow Rules

## Mandatory Golden Rule for AI Assistants: Never Start With Code

When working on any phase from the `fixes/` folder:

1. **Teach First (Concept & Purpose Deep-Dive):**
   - Before writing or modifying any source code, Kubernetes manifests, or tests, you MUST teach the user the concepts behind that phase.
   - Write a detailed lesson to `fixes/lessons/NN-<topic>.md` covering:
     1. The Big Picture (purpose in plain language)
     2. The Problem Today (concrete scenarios with our existing code)
     3. Core Concepts (from scratch, ASCII diagrams, analogies)
     4. How It Applies Here (mapping to services, models, events)
     5. Alternatives & Trade-offs (why we picked this design)
     6. What Will Change (preview of files and architectural shift)
     7. Glossary & Key Terms
     8. Self-Check Questions with collapsible answers
   - Also explain the essence directly in conversation, highlighting the "why" and answering any queries.

2. **Wait for Comprehension and Explicit User Signal:**
   - Ask the user if they have any questions or want deeper explanations on any part.
   - **DO NOT TOUCH OR EDIT ANY CODE OR MANIFESTS** until the user explicitly gives you the signal (e.g., "I understand, go ahead with Phase XX", "Start implementation", etc.).
   - Never assume approval.

3. **Step-by-Step Implementation:**
   - Once the user gives the go-ahead, implement in clean, reviewable, well-structured steps.
   - Adhere strictly to the non-negotiable coding rules in `fixes/README.md`.
   - Keep the codebase human-readable, simple, and clean (no bloated AI slop or unnecessary abstractions).

4. **Proof & Results:**
   - Run tests, load tests, or chaos tests to measure behavior.
   - Record metrics and proof in `fixes/results/phase-NN-*.md`.

5. **Interview Notes:**
   - Write revision notes in `fixes/notes/NN-*.md` using the standard interview-ready template.
