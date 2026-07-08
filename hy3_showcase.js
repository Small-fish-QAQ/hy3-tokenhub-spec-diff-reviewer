#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const path = require('node:path');

const TOKENHUB_ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/chat/completions';
const MODEL = 'hy3';
const DEMOS = ['chat', 'summarize', 'code-review', 'brief'];
const COMMANDS = new Set([...DEMOS, 'all']);

class FriendlyError extends Error {}

async function main() {
  const command = process.argv[2];

  if (!command || !COMMANDS.has(command)) {
    if (command) {
      console.error(`Invalid command: ${command}`);
      console.error('');
    }
    printUsage();
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.TOKENHUB_API_KEY;
  if (!apiKey || apiKey === 'your_tokenhub_api_key_here') {
    throw new FriendlyError(
      'Missing TOKENHUB_API_KEY. Copy .env.example to .env, add your TokenHub key, and run the command again.'
    );
  }

  const demos = command === 'all' ? DEMOS : [command];

  for (const demo of demos) {
    const request = await buildDemoRequest(demo);
    printSection(request.title);
    const response = await askHy3(request.messages, apiKey);
    console.log(response);
  }
}

function printUsage() {
  console.log('Usage: node hy3_showcase.js <command>');
  console.log('');
  console.log('Commands:');
  console.log('  chat');
  console.log('  summarize');
  console.log('  code-review');
  console.log('  brief');
  console.log('  all');
}

async function buildDemoRequest(demo) {
  if (demo === 'chat') {
    return {
      title: 'Chat Demo',
      messages: [
        {
          role: 'system',
          content: 'You are Hy3, a concise and helpful assistant.'
        },
        {
          role: 'user',
          content: 'Say hello in one short paragraph and explain what you can help developers prototype.'
        }
      ]
    };
  }

  if (demo === 'summarize') {
    const sampleText = await readExampleFile('sample_text.txt');
    return {
      title: 'Summarize Demo',
      messages: [
        {
          role: 'system',
          content: 'You summarize technical text clearly and briefly.'
        },
        {
          role: 'user',
          content: `Summarize the following text in three concise bullet points:\n\n${sampleText}`
        }
      ]
    };
  }

  if (demo === 'code-review') {
    const sampleCode = await readExampleFile('sample_code.js');
    return {
      title: 'Code Review Demo',
      messages: [
        {
          role: 'system',
          content: 'You review JavaScript code for correctness, maintainability, and practical improvements.'
        },
        {
          role: 'user',
          content: `Review this JavaScript snippet. Keep the feedback short and actionable:\n\n\`\`\`js\n${sampleCode}\n\`\`\``
        }
      ]
    };
  }

  const sampleText = await readExampleFile('sample_text.txt');
  const sampleCode = await readExampleFile('sample_code.js');

  return {
    title: 'Developer Brief Demo',
    messages: [
      {
        role: 'system',
        content: 'You create concise developer briefs from project notes and code samples.'
      },
      {
        role: 'user',
        content: [
          'Generate a structured developer brief with exactly these sections:',
          '1. Project Summary',
          '2. Code Review Findings',
          '3. Suggested Next Steps',
          '',
          'Project note:',
          sampleText,
          '',
          'Code sample:',
          '```js',
          sampleCode,
          '```'
        ].join('\n')
      }
    ]
  };
}

async function readExampleFile(fileName) {
  const filePath = path.join(__dirname, 'examples', fileName);
  return fs.readFile(filePath, 'utf8');
}

async function askHy3(messages, apiKey) {
  let response;

  try {
    response = await fetch(TOKENHUB_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 600
      })
    });
  } catch (error) {
    throw new FriendlyError(
      `Network error while calling TokenHub: ${error.message || error}. Check your connection and try again.`
    );
  }

  const bodyText = await response.text();

  if (!response.ok) {
    const safeBody = redactSecret(bodyText, apiKey);
    throw new FriendlyError(
      `TokenHub returned HTTP ${response.status} ${response.statusText}.\nResponse body:\n${safeBody || '(empty)'}`
    );
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new FriendlyError('TokenHub returned a successful response, but it was not valid JSON.');
  }

  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new FriendlyError('TokenHub returned a response, but no message content was found.');
  }

  return content.trim();
}

function redactSecret(text, secret) {
  if (!text || !secret) {
    return text;
  }

  return text.split(secret).join('[redacted]');
}

function printSection(title) {
  console.log('');
  console.log('='.repeat(64));
  console.log(`${title} (${MODEL})`);
  console.log('='.repeat(64));
}

main().catch((error) => {
  const message =
    error instanceof FriendlyError
      ? error.message
      : `Unexpected error: ${error.message || error}`;

  console.error('');
  console.error(message);
  process.exitCode = 1;
});
