#!/usr/bin/env node

process.on('uncaughtException', (err) => {
  console.error(`[dude] Fatal error: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(`[dude] Unhandled rejection: ${err?.message || err}`);
  process.exit(1);
});

const command = process.argv[2] || 'mcp';

try {
  switch (command) {
    case 'mcp': {
      const { startServer } = await import('../src/server.js');
      await startServer();
      break;
    }
    case 'serve': {
      const { startWebServer } = await import('../src/web.js');
      await startWebServer();
      break;
    }
    case 'auto-retrieve': {
      await import('../hooks/auto-retrieve.js');
      break;
    }
    case 'auto-persist': {
      await import('../hooks/auto-persist.js');
      break;
    }
    case 'auto-persist-plan': {
      await import('../hooks/auto-persist-plan.js');
      break;
    }
    default:
      console.error(`Usage: dude-claude [mcp|serve|auto-retrieve|auto-persist|auto-persist-plan]

Commands:
  mcp               Start the MCP stdio server (default)
  serve             Start the web UI server on http://127.0.0.1:${process.env.DUDE_PORT || 3456}
  auto-retrieve     Run the auto-retrieve hook (reads prompt from stdin)
  auto-persist      Run the auto-persist utility (reads classification JSON from stdin)
  auto-persist-plan Run the auto-persist-plan utility (reads classification JSON from stdin)`);
      process.exit(1);
  }
} catch (err) {
  console.error(`[dude] Startup failed: ${err.message}`);
  process.exit(1);
}
