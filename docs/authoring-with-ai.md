# Authoring a project with AI

You rarely need to write an `.aitrack` file by hand.

> **An AI chat given the path of this file** to plan a project: follow [Steps for an AI chat](#steps-for-an-ai-chat) below. They work for a new project and for one already under way.

**In the app** this is built in: **New project** → *Plan* → **Create with AI here** runs Claude Code, Codex, Gemini or Copilot on your computer, read-only in the project's folder, with the instructions below; **Use another AI** copies the same instructions for any chat and checks the answer you paste back. A project without tasks has **Plan with AI** on its board. You see the tasks before anything is saved. The steps below are for doing it by hand.

 Give an AI your plan (a design doc, a roadmap, a list of prompts) together with the instructions below, and ask it to produce the file. Then validate it, open it in the app and review the graph — the **Flow** view makes wrong dependencies easy to spot.

## Steps

1. Collect the inputs: the plan, the list of chats you will run (for example "Claude A, Claude B, Codex A, Codex B, Codex C") and what each is good at, the repository layout, and any prompts you already have.
2. Paste the instructions below into a capable model, followed by the inputs.
3. Save the answer as `<project>.aitrack` in the repository that holds the plan.
4. Validate: `npm run validate -- path/to/<project>.aitrack` (in this repository). Fix errors, or paste them back to the AI.
5. Open it in the app (**Add project**), check the **Flow** view, adjust, and commit.

To change the plan later, give the AI the current file plus the change, and ask for the full updated file. Keep task ids stable so the status history still matches.

## Steps for an AI chat

You were given this file to make a project file for the repository you work in. Work in this order and do not change any code while you do it.

1. **Find out where the project stands.** Read the README, docs, roadmap and issue lists in the repository; look at `git log`, the branches and open pull requests (`gh pr list` if you can), the tests (run them if you can) and TODO/FIXME notes. A project with no code yet skips to step 3.
2. **Show three lists** and ask the person to correct them: *Done* (with the evidence: code, tests, merged PRs), *Half done* (what exists, what is missing, which branch or PR), *Left* (in the order you would do it).
3. **Ask what you cannot find out yourself**, in one message: which AI chats will work on it (names, which tool — Claude Code, Codex, Gemini, Copilot, Cursor, DeepSeek — and what each is good at or may not do), priorities and dates, the language of the plan (English or Turkish), constraints (paths not to touch, required checks, limits such as CI minutes), and where the file should go.
4. **When the person confirms**, write the file with the instructions in the block below, using what you found and what they answered as the INPUTS: only the work that is left, the chats exactly as they named them, `settings.language` when it is not English, and `settings.repoPath` when the file is not in the root of the code repository. Save it as `<project-id>.aitrack` where they asked (the repository root by default).
5. **Check it** against the list at the end of the block (every id exists, no cycles, parallel tasks touch different paths, every task has acceptance and an estimate). If the AI Tracking System repository is on this computer, `npm run validate -- <file>` there checks it too.
6. **Tell the person** where the file is, which tasks can start at once and the longest chain of work, and that they open it in the app with **New project → I already have an .aitrack file** (or **Add project**).

## Instructions for the AI

Copy everything in this block.

````text
You are converting a software plan into an AI Tracking System project file (.aitrack, format version 1).
The file is used to run several AI chats in parallel: a task can be sent as soon as all tasks it
depends on are done and its chat is free. Your goal is the shortest total time with safe parallel work.

OUTPUT
- Output exactly one JSON document and nothing else. No comments, no trailing commas.
- Start with: "$schema": "https://raw.githubusercontent.com/mitradeniz/ai-tracking-system/main/schema/aitrack.schema.json",
  "format": "aitrack", "version": 1.
- Top-level keys in this order: $schema, format, version, project, settings, agents, milestones, tasks, prompts.
- Ids: letters, digits, ".", "_", "-"; start with a letter or digit; max 80 chars. Never reuse an id.

SCHEMA (fields you may use)
- project: { id, name, description?, links?: [{label, url}] }
- settings: { requireApproval?: boolean, inboxDir?: ".aitrack/inbox", repoPath?: "<path of the code repo relative to this file>" }
- agents[]: { id, name, tool?, role?, capabilities?: string[], maxParallel?: 1, bootstrapPrompts?: promptId[], quickPrompts?: promptId[] }
- milestones[]: { id, name, date?: "YYYY-MM-DD", description? }
- tasks[]: { id, title, description?, agent, alsoAgents?: agentId[], dependsOn?: taskId[], prompts?: promptId[],
             instructions?, scope?, allowedPaths?: string[], acceptance?, milestone?, estimateDays?, tags?: string[] }
- prompts: { "<promptId>": { title?, body } }

HOW TO SPLIT THE WORK
1. One task = one reviewable unit of work for one chat, ideally 0.5–3 days and one pull request.
   Split anything bigger. Do not create tasks smaller than about two hours.
2. dependsOn lists only REAL prerequisites: the task cannot be done correctly without the other task's
   merged output (a contract, a schema, a shared library, infrastructure it runs on). Do not add a
   dependency just because tasks are in the same phase or "it feels later". Prefer contract-first:
   when B only needs A's interface, make a small contract task that both A and B depend on, so A and B
   run in parallel against a mock.
3. Parallel tasks must not edit the same files. Give every task allowedPaths, and make tasks that can
   run at the same time touch disjoint paths. If two tasks must touch the same file, make one depend on
   the other or extract the shared change into its own task.
4. Add integration tasks where parallel streams meet (wire the real service in place of the mock,
   end-to-end test) and review/QA tasks where risk is high.
5. Every task has acceptance criteria that can be checked: commands that pass, behaviour to observe,
   files that exist.
6. Give estimateDays to every task; it is used for the critical path.
7. No cycles. Every dependsOn id must exist.

HOW TO ASSIGN CHATS
- Use exactly the chats listed in the inputs; copy their names and strengths into agents[].role and
  capabilities. Assign each task to the chat whose strengths fit best. Respect hard constraints from
  the inputs (for example: only some chats can use a browser or generate images).
- Balance the load: look at the tasks that can run at the same time and spread them across chats.
- When another chat could also do a task well, list it in alsoAgents so work moves when the owner is busy.
- maxParallel is 1 unless the inputs say a chat can handle more.

PROMPTS
- Make one shared context prompt (product, stack, repository layout, conventions, rules for parallel
  work: stay inside allowed paths, small PRs, never commit secrets, ask instead of guessing).
- Make one session prompt per chat (its role, what it owns, what it must not touch).
  bootstrapPrompts of each chat = [shared context id, its session prompt id].
- Reuse the prompts from the inputs verbatim when they exist; reference them by id from tasks.
  When one prompt covers several tasks, reference it from each and set task.scope to the part each
  task covers.
- Put task-specific details in task.instructions. Do not repeat the shared context in every task.
- Recurring duties (code review, QA round, integration check) are prompts referenced from
  agents[].quickPrompts.
- Do not write reporting instructions; the app appends them to every task prompt.
- Never put secrets, credentials, personal data or customer data in the file.

MILESTONES
- Map the plan's phases or sprints to milestones with dates when the plan has them, and set
  task.milestone.

A PROJECT ALREADY UNDER WAY
- Plan only the work that is left. Do not create tasks for work that is done; say in the shared
  context prompt what already exists and where.
- Work that is half done becomes a task for the missing part only: say what exists and what is left.
- Do not add dependencies on finished work.
- When you cannot tell whether something is done, add a short first task that checks it and reports,
  instead of guessing.

Before answering, check: every id referenced exists; no cycles; tasks that can run in parallel have
disjoint allowedPaths; every task has prompts or instructions, acceptance and estimateDays.

INPUTS
<paste the plan, the list of chats with their strengths, the repository layout and existing prompts here>
````

## Tips

- Ask the AI for a short list of the tasks that can start immediately and the critical path after the file; compare it with the app's **Flow** view.
- If the AI produced too many dependencies, ask: "For each dependsOn edge, state what merged output is needed. Remove edges without one."
- Large plans: generate one milestone at a time, then ask for a merge into one file with stable ids.
- Keep prompts in the file rather than in links, so the app can copy them in one click.
