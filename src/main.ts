import { App } from './app/App.ts';

const root = document.getElementById('app');
if (root) {
  const app = new App(root);
  // exposed for debugging and the automated browser smoke test
  (window as unknown as { kineticScore: App }).kineticScore = app;
  app.start().catch((e: unknown) => {
    console.error(e);
    root.textContent = `Kinetic Score failed to start: ${e instanceof Error ? e.message : String(e)}`;
  });
}
