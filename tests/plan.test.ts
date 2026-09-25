import { describe, expect, it } from "vitest";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { parsePlanJson, validatePlan, PlanValidationError } from "../src/plan.ts";
import { formatPlanSummary, insertPlan, promoteReady } from "../src/plan-store.ts";
import { upsertProject } from "../src/project.ts";
import { getTask } from "../src/tasks.ts";

const valid = {
  version: 1,
  projectSummary: "A small game",
  architecture: { summary: "One page", decisions: ["No build step"] },
  tasks: [
    {
      tempId: "scaffold",
      title: "Scaffold application",
      description: "Add the page",
      agent: "builder",
      dependencies: [],
      acceptanceCriteria: ["index.html exists"],
    },
    {
      tempId: "tests",
      title: "Add tests",
      description: "Check the page",
      agent: "tester",
      dependencies: ["scaffold"],
      acceptanceCriteria: ["A check exists"],
    },
  ],
};

describe("ProjectPlan schema", () => {
  it("accepts a version 1 plan", () => {
    const plan = validatePlan(valid);
    expect(plan.tasks).toHaveLength(2);
    expect(formatPlanSummary("Build Tic Tac Toe", plan)).toContain("Plan valid: yes");
    expect(formatPlanSummary("Build Tic Tac Toe", plan)).toContain("Depends on: 1");
  });

  it("rejects duplicate planner task ids", () => {
    const plan = structuredClone(valid);
    plan.tasks[1].tempId = "scaffold";
    expect(() => validatePlan(plan)).toThrow(/duplicate task id 'scaffold'/);
  });

  it("rejects a missing dependency reference", () => {
    const plan = structuredClone(valid);
    plan.tasks[1].dependencies = ["api"];
    expect(() => validatePlan(plan)).toThrow(/task 'tests' depends on unknown task 'api'/);
  });

  it("rejects a dependency cycle", () => {
    const plan = structuredClone(valid);
    plan.tasks[0].dependencies = ["tests"];
    expect(() => validatePlan(plan)).toThrow(/dependency cycle/);
  });

  it("rejects a self-dependency", () => {
    const plan = structuredClone(valid);
    plan.tasks[0].dependencies = ["scaffold"];
    expect(() => validatePlan(plan)).toThrow(/depends on itself/);
  });

  it("rejects an unknown agent role", () => {
    const plan = structuredClone(valid);
    plan.tasks[0].agent = "ceo";
    expect(() => validatePlan(plan)).toThrow(/unknown agent 'ceo'/);
  });

  it("rejects an empty plan", () => {
    expect(() => validatePlan({ version: 1, projectSummary: "x", tasks: [] })).toThrow(/no tasks/);
  });

  it("rejects malformed model output", () => {
    expect(() => parsePlanJson("not json")).toThrow(PlanValidationError);
    expect(() => validatePlan(parsePlanJson('{"version":2,"projectSummary":"x","tasks":[]}'))).toThrow(/unsupported plan version/);
  });
});

describe("plan persistence", () => {
  it("maps temporary ids, marks ready work, and rolls back a failed insert", () => {
    const db = openDatabase(":memory:");
    const projectId = upsertProject(db, { name: "game", root: "/tmp/game" });
    const plan = validatePlan(valid);
    const stored = insertPlan(db, projectId, plan);
    expect(stored[0]?.taskId).not.toBe("scaffold");
    expect(stored[1]?.dependencies).toEqual(["scaffold"]);
    const first = getTask(db, stored[0]!.taskId);
    const second = getTask(db, stored[1]!.taskId);
    expect(first.status).toBe("READY");
    expect(second.status).toBe("PENDING");
    expect(JSON.parse(second.dependencies_json)).toEqual([first.id]);
    db.prepare("UPDATE tasks SET status = 'DONE' WHERE id = ?").run(first.id);
    const promoted = promoteReady(db, projectId);
    expect(promoted.map((task) => task.id)).toEqual([second.id]);
    expect(getTask(db, second.id).status).toBe("READY");

    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON tasks WHEN (SELECT COUNT(*) FROM tasks) >= 2 BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(() => insertPlan(db, projectId, plan)).toThrow(/boom/);
    const count = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number };
    expect(count.count).toBe(2);
    closeDatabase(db);
  });
});
