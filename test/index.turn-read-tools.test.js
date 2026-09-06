import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { registerTurnReadTools } from '../index.js';
import { BOOKMARK_PREVIEW_CHARS } from '../lib/bookmark-core.js';

const decoded = (result) => JSON.parse(result.content[0].text);

describe('registerTurnReadTools', () => {
  let client;
  let calls;

  before(async () => {
    calls = [];
    const turnReadService = {
      turnPage(args) {
        calls.push(['page', args]);
        if (args.before === 'S9:999999') throw new Error('Omit before and start from the newest page.');
        return { turn_page: 'page' };
      },
      turnSearch(args) {
        calls.push(['search', args]);
        return { found: false, recovery: 'locate' };
      },
      turnLocate(args) {
        calls.push(['locate', args]);
        return { found: false, recovery: 'page' };
      },
    };
    const mcpServer = new McpServer({ name: 'turn-read-test', version: '0.0.0' });
    registerTurnReadTools({
      mcpServer, z, turnReadService,
      reply: (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }),
    });

    client = new Client({ name: 'turn-read-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  after(async () => { await client.close(); });

  test('the real MCP tool list exposes the three schemas', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), ['turn_locate', 'turn_page', 'turn_search']);
    const page = tools.find(({ name }) => name === 'turn_page');
    const search = tools.find(({ name }) => name === 'turn_search');
    const locate = tools.find(({ name }) => name === 'turn_locate');
    assert.equal(typeof page.inputSchema.properties.before.pattern, 'string');
    assert.equal(search.inputSchema.properties.scope.pattern, page.inputSchema.properties.before.pattern);
    assert.deepEqual(search.inputSchema.required, ['q']);
    assert.deepEqual(locate.inputSchema.required, ['q']);
    assert.equal(search.inputSchema.properties.q.maxLength, BOOKMARK_PREVIEW_CHARS);
    assert.equal(locate.inputSchema.properties.q.maxLength, BOOKMARK_PREVIEW_CHARS);
    // Every tool and parameter description is the sole carrier of its own contract, and each one has to
    // survive the schema conversion to reach the client at all — a `.describe()` dropped from the
    // registration leaves every other assertion here green. What a description SAYS is not asserted:
    // this repo takes prose guards out rather than adding them (`.serena/memories/conventions.md`
    // Testing), and a token check reddens when the wording improves while staying green when the
    // guidance behind it is gutted.
    const described = [
      page.description, search.description, locate.description,
      page.inputSchema.properties.before.description,
      search.inputSchema.properties.q.description,
      search.inputSchema.properties.scope.description,
      locate.inputSchema.properties.q.description,
    ];
    for (const [i, description] of described.entries()) {
      assert.equal(typeof description, 'string', `described[${i}] never reached the client`);
      assert.ok(description.length > 0, `described[${i}] arrived empty`);
    }
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.inputSchema.properties.lineage_head, undefined, tool.name);
    }
  });

  test('successful calls dispatch through the registered handlers without changing arguments', async () => {
    assert.deepEqual(decoded(await client.callTool({
      name: 'turn_page', arguments: { before: 'S1:2' },
    })), { turn_page: 'page' });
    await client.callTool({ name: 'turn_search', arguments: { q: 'literal', scope: 'S1:2' } });
    await client.callTool({ name: 'turn_locate', arguments: { q: 'term' } });
    assert.deepEqual(calls, [
      ['page', { before: 'S1:2' }],
      ['search', { q: 'literal', scope: 'S1:2' }],
      ['locate', { q: 'term' }],
    ]);
  });

  // The newest page is asked for with an empty object rather than by omitting `arguments` — the schema
  // has no required field, so `{}` is the entire call. This is the shape the skill describes and the
  // shape the manual check uses, so the handler receiving `{}` is pinned here rather than assumed.
  test('an empty argument object reaches the page handler as an empty object', async () => {
    assert.deepEqual(decoded(await client.callTool({ name: 'turn_page', arguments: {} })), { turn_page: 'page' });
    assert.deepEqual(calls.at(-1), ['page', {}]);
  });

  test('blank q is rejected by both MCP schemas before either service method runs', async () => {
    const count = calls.length;
    for (const name of ['turn_search', 'turn_locate']) {
      const result = await client.callTool({ name, arguments: { q: '   ' } });
      assert.equal(result.isError, true, name);
      assert.equal(typeof result.content[0].text, 'string', name);
    }
    assert.equal(calls.length, count);
  });

  test('a thrown address recovery reaches the caller as the SDK isError envelope', async () => {
    const result = await client.callTool({
      name: 'turn_page', arguments: { before: 'S9:999999' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Omit before and start from the newest page.');
  });
});
