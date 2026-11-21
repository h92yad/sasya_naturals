'use strict';

const { BANNED_PORTFOLIO_DOMAINS } = require('../../config/appConfig');

const BANNED_AI_BUZZWORDS = [
  'delve',
  'tapestry',
  'pivotal',
  'testament',
  'vibrant',
  'interplay',
  'foster',
  'showcase',
  'underscore',
  'garner',
  'enduring',
  'nestled in the heart'
];

const EM_DASH_REGEX = /[—–]/;
const WIKIDATA_HOST = ['wikidata', 'org'].join('\\.');
const WIKIDATA_REGEX = new RegExp(`${WIKIDATA_HOST}|\\/entity\\/Q\\d+|\\/wiki\\/Q\\d+`, 'i');

function lintContentText(text, label = 'content') {
  const issues = [];
  if (!text || typeof text !== 'string') return { valid: true, issues };

  if (EM_DASH_REGEX.test(text)) {
    issues.push(`[${label}] Contains banned em-dash or en-dash character (— / –). Use periods, commas, or colons.`);
  }

  const lower = text.toLowerCase();
  for (const word of BANNED_AI_BUZZWORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      issues.push(`[${label}] Contains banned AI buzzword "${word}" (humanizer-en violation).`);
    }
  }

  if (WIKIDATA_REGEX.test(text)) {
    issues.push(`[${label}] Contains banned Wikidata reference (1-year moratorium violation).`);
  }

  for (const domain of BANNED_PORTFOLIO_DOMAINS) {
    if (lower.includes(domain.toLowerCase())) {
      issues.push(`[${label}] Contains cross-domain footprint bleed "${domain}".`);
    }
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

module.exports = {
  BANNED_AI_BUZZWORDS,
  lintContentText
};
