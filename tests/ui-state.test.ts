import { strict as assert } from "node:assert";
import { test } from "node:test";
import { retainStatus, createSetupTask } from "../src/state";
import { DEFAULT_CONFIG, Status } from "../service/protocol";

// Effect replay must join the in-flight operation instead of racing a second installer/restart.
test("setup effect replay shares one operation and permits a later retry", async () => {
  const run = createSetupTask();
  let finish!: () => void;
  let attempts = 0;
  const gate = new Promise<void>((done) => {
    finish = done;
  });
  const first = run(async () => {
    attempts += 1;
    await gate;
  });
  const replay = run(async () => {
    attempts += 1;
  });
  assert.equal(replay, first);
  finish();
  await Promise.all([first, replay]);
  assert.equal(attempts, 1);
  await run(async () => {
    attempts += 1;
  });
  assert.equal(attempts, 2);
});

test("failed setup releases its command-local operation for retry", async () => {
  const run = createSetupTask();
  await assert.rejects(
    run(async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  let retried = false;
  await run(async () => {
    retried = true;
  });
  assert.equal(retried, true);
});

// Polling identical status must not cause Raycast to repeatedly render an unchanged view.
test("unchanged status keeps its object identity", () => {
  const previous: Status = {
    version: 1,
    config: DEFAULT_CONFIG,
    activity: "idle",
    missingRoots: [],
    modelReady: true,
  };
  assert.equal(retainStatus(previous, structuredClone(previous)), previous);
  const changed = { ...previous, activity: "indexing" };
  assert.equal(retainStatus(previous, changed), changed);
  assert.equal(retainStatus(undefined, changed), changed);
});
