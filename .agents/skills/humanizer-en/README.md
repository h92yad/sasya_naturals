# Humanizer EN (v3.0.0)

A high-performance, anti-detection English Agent Skill and production prompt system. Designed to eliminate signs of AI writing, improve natural human cadence, and drive statistical AI detection scores (Turnitin, GPTZero) below 20%.

---

## Features & Architecture

* **Dual-Tier Architecture**:
  * **Tier 1 (`humanizer-light.md`)**: Ultra-compact system prompt (<400 tokens) tailored for local Ollama `qwen2.5:3b` / `1.5b` models in **`ewith.me`**. Fast streaming, zero timeout risk (<15s), and Turnitin <20% AI match optimization.
  * **Tier 2 (`SKILL.md`)**: Pro Agent profile featuring 33 Wikipedia AI writing patterns, 50-point Quality Matrix, Pre-Flight Quick Checklist, and Soul Injection framework for cloud LLMs (Claude 3.5, GPT-4o, Gemini 2.0).
* **Anti-Turnitin Engine**: Combines **Extreme Burstiness** (sentence length alternation) and **High Perplexity** (banning AI transition crutches like *Furthermore*, *Moreover*, *In conclusion*).
* **No Fabrication Rule**: Guaranteed factual integrity—rewrites never hallucinate dates, names, facts, or citations.

---

## Quick Start & Installation

### Option 1: Antigravity / Agent Skills (Global / Workspace)
Simply place `humanizer-en` inside your workspace `.agents/skills/` directory:
```
.agents/skills/humanizer-en/
├── SKILL.md
├── humanizer-light.md
└── README.md
```

### Option 2: `ewith.me` Local Ollama Integration (`server.js`)
Use `humanizer-light.md` as the system prompt payload in `/api/chat` or `/api/generate`:
```javascript
const systemPrompt = fs.readFileSync('humanizer-light.md', 'utf8');

const payload = {
  model: 'qwen2.5:3b',
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: textToHumanize }
  ],
  stream: true
};
```

---

## 33 Detected AI Patterns

| Category | Patterns Included |
| :--- | :--- |
| **Content** | Significance inflation, Notability name-dropping, Superficial `-ing` analyses, Promotional language, Vague attributions, Formulaic challenge sections. |
| **Language** | AI vocabulary (*delve, tapestry, landscape, pivotal, testament, vibrant*), Copula avoidance, Negative parallelisms, Rule of three, Synonym cycling, False ranges, Passive voice fragments. |
| **Style** | **Hard Em-dash ban (`—`)**, Boldface overuse, Inline-header lists, Title case headings, Emojis, Curly quotes, Hyphenated pair overuse, Persuasive authority tropes, Signposting announcements, Fragmented headers, Diff-anchored writing, Manufactured staccato drama, Aphorism formulas, Conversational openers. |
| **Communication & Filler** | Chatbot artifacts, Knowledge cutoff disclaimers, Sycophantic tone, Filler phrases (*"in order to"*), Excessive hedging, Generic positive conclusions. |

---

## 50-Point Quality Matrix

Rewrites in Pro mode are evaluated against 5 core criteria:

```
Directness      [ /10 ] - No conversational preamble or fluff
Rhythm & Flow   [ /10 ] - Extreme burstiness & sentence length variation
Reader Trust    [ /10 ] - Zero false depth or superficial -ing phrases
Authenticity    [ /10 ] - Human voice with stance & concrete details
Conciseness     [ /10 ] - Zero redundant words or synonym cycling
Total           [ /50 ] - Target: ≥ 45 / 50
```

---

## Validation

Run the included validation script to verify package integrity:
```bash
python scripts/validate-package.py
```

---

## License

MIT License.
