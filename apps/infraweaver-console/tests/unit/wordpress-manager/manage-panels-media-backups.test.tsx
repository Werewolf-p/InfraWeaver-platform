import {
  assessBackup,
  relativeAge,
} from "@/addons/wordpress-manager/components/demo/manage/panels-backups";
import type { BackupsData } from "@/addons/wordpress-manager/lib/manage/probes/backups";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

function backups(overrides: Partial<BackupsData>): BackupsData {
  return {
    plugin: "updraftplus",
    updraft: true,
    schedule: "daily",
    retainSets: 3,
    lastBackupAt: null,
    lastBackupOk: null,
    files: [],
    totalMb: 0,
    ...overrides,
  };
}

describe("relativeAge", () => {
  test("returns 'never' when there is no timestamp", () => {
    expect(relativeAge(null, NOW)).toBe("never");
  });

  test("formats minutes, hours and days ago", () => {
    expect(relativeAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(relativeAge(new Date(NOW - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3 hours ago");
    expect(relativeAge(new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2 days ago");
  });

  test("singularises a one-day-old backup", () => {
    expect(relativeAge(new Date(NOW - 25 * 60 * 60_000).toISOString(), NOW)).toBe("1 day ago");
  });
});

describe("assessBackup", () => {
  test("critical when no backup has ever run", () => {
    const posture = assessBackup(backups({ lastBackupAt: null }), NOW);
    expect(posture.tone).toBe("critical");
    expect(posture.headline).toBe("No backup on record");
  });

  test("critical when the last recorded backup reported errors", () => {
    const posture = assessBackup(
      backups({ lastBackupAt: new Date(NOW - 60 * 60_000).toISOString(), lastBackupOk: false }),
      NOW,
    );
    expect(posture.tone).toBe("critical");
    expect(posture.ok).toBe(false);
  });

  test("good when a recent backup succeeded", () => {
    const posture = assessBackup(
      backups({ lastBackupAt: new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(), lastBackupOk: true }),
      NOW,
    );
    expect(posture.tone).toBe("good");
    expect(posture.ok).toBe(true);
    expect(posture.headline).toContain("Last backup");
  });

  test("warn when the last good backup is over a week old", () => {
    const posture = assessBackup(
      backups({ lastBackupAt: new Date(NOW - 10 * 24 * 60 * 60_000).toISOString(), lastBackupOk: true }),
      NOW,
    );
    expect(posture.tone).toBe("warn");
  });
});
