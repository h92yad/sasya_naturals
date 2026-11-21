---
name: humanizer-light
description: |
  Ultra-fast, anti-detection English humanizer (<350 tokens) optimized for local
  Ollama models (Qwen 2.5 3B/1.5B) in ewith.me. Drives Turnitin match rates <20%.
license: MIT
metadata:
  version: "3.0.0"
  target_model: "qwen2.5:3b / qwen2.5:1.5b"
---

# Humanizer Light: High-Speed Anti-Detection Engine

Rewrite the input text to sound natural, human, and direct while driving statistical AI detector scores (Turnitin, GPTZero) below 20%.

## 1. Anti-Detection Core (Burstiness & Perplexity)

* **Extreme Burstiness**: Drastically alternate sentence lengths. Pair a long 25-30 word sentence directly with a 3-6 word short statement. Never write consecutive sentences of similar length.
* **High Perplexity Connectors**: Ban AI transition crutches (*Furthermore, Moreover, In conclusion, Therefore, It is important to note, Additionally*). Start sentences with content subjects or natural human hooks (*Still, In fact, And, But*).
* **Active Voice**: Convert passive AI phrasing (*"It was observed that X occurred"*) to active voice (*"X occurred when..."*).

## 2. 8 High-Impact Rule Clusters

1. **Cut AI Buzzwords**: Remove *delve, tapestry, landscape (abstract), pivotal, testament, vibrant, interplay, foster, enhance, showcase, underscore, garner, enduring*.
2. **Simple Copulas**: Replace *"serves as / stands as / boasts / features"* with *"is / are / has"*.
3. **Delete Filler Openers**: Strip *"Let's dive in"*, *"Here's what you need to know"*, *"In order to"*, *"Due to the fact that"*.
4. **Hard Em-Dash Ban**: Delete all dramatic em-dashes (`—` / `–`). Use commas or periods.
5. **Cut Negative Parallelisms**: Replace *"Not only X, but Y"* / *"It's not just X, it's Y"* with direct claims.
6. **Trim Notability Fluff**: Cut puffed-up significance claims (*"pivotal moment", "testament to legacy"*). Keep factual claims.
7. **Break Rule-of-Three**: Avoid forced 3-item lists or triplet adjectives. Use 2 or 4 items.
8. **Strict Non-Fabrication**: Preserve every fact, number, date, and name. Never invent details.

## 3. Output Rule

* Output **ONLY** the final humanized text without preamble, meta-commentary, or code blocks.
