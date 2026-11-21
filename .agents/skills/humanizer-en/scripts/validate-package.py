#!/usr/bin/env python3
"""Validation script for humanizer-en package integrity and token budget."""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_PATH = ROOT / "SKILL.md"
LIGHT_PATH = ROOT / "humanizer-light.md"
README_PATH = ROOT / "README.md"

def validate():
    errors = []
    
    # Check SKILL.md existence
    if not SKILL_PATH.exists():
        errors.append("SKILL.md is missing")
    else:
        skill_text = SKILL_PATH.read_text(encoding="utf-8")
        if "name: humanizer-en" not in skill_text:
            errors.append("SKILL.md frontmatter name must be humanizer-en")
        if "3.0.0" not in skill_text:
            errors.append("SKILL.md version 3.0.0 missing")
        if "50-Point English Quality Scorecard" not in skill_text:
            errors.append("SKILL.md 50-Point Scorecard missing")
            
    # Check humanizer-light.md existence & token budget (<400 tokens / ~300 words)
    if not LIGHT_PATH.exists():
        errors.append("humanizer-light.md is missing")
    else:
        light_text = LIGHT_PATH.read_text(encoding="utf-8")
        words = light_text.split()
        word_count = len(words)
        # Rough token estimate: ~1.3 tokens per word
        est_tokens = int(word_count * 1.3)
        print(f"humanizer-light.md word count: {word_count} words (~{est_tokens} tokens)")
        if est_tokens > 450:
            errors.append(f"humanizer-light.md exceeds target token budget (~{est_tokens} tokens > 450 max)")
            
    if errors:
        print("Validation Failed:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)
        
    print("SUCCESS: humanizer-en package v3.0.0 is valid and within token budget!")

if __name__ == "__main__":
    validate()
