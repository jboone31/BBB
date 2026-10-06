import { describe, expect, it } from "vitest";

import type { GameEvent } from "@/lib/events";

import {
  type RealtimeChannel,
  type RealtimeChannelStatus,
  type RealtimeTransport,
  subscribe,
} from "./index";
import type { SnapshotSource } from "./snapshot";

const GAME_ID = "game-subscribe";

function event(seq: number): GameEvent {
  return {
    id: `${GAME_ID}-${seq}`,
    gameId: GAME_ID,
    seq,
    eventType: "test_event",
    actorKind: "system",
    actorTeamId: null,
    payload: { seq },
    createdAt: new Date(seq).toISOString(),
  };
}

class FakeChannel implements RealtimeChannel {
  readonly ready = Promise.resolve();
  unsubscribed = false;

  unsubscribe(): void {
    this.unsubscribed = true;
  }
}

class BufferingTransport implements RealtimeTransport {
  readonly channelHandle = new FakeChannel();

  channel(
    _gameId: string,
    onRow: (event: GameEvent) => void,
    onStatus?: (status: RealtimeChannelStatus) => void,
  ): RealtimeChannel {
    onStatus?.("SUBSCRIBED");
    onRow(event(1));
    onRow(event(2));
    return this.channelHandle;
  }
}

function delayedSnapshot(): SnapshotSource {
  return {
    async fetchEventsAscending(): Promise<GameEvent[]> {
      await Promise.resolve();
      return [event(1)];
    },
  };
}

describe("subscribe startup lifecycle", () => {
  it("buffers rows during snapshot hydration and drains them exactly once", async () => {
    const applied: number[] = [];
    const statuses: RealtimeChannelStatus[] = [];
    const transport = new BufferingTransport();

    const subscription = await subscribe(GAME_ID, {
      transport,
      snapshotSource: delayedSnapshot(),
      handlers: {
        onEvent: (received) => applied.push(received.seq),
        onChannelStatus: (status) => statuses.push(status),
      },
    });

    expect(subscription.snapshot.lastSeenSequence).toBe(1);
    expect(applied).toEqual([2]);
    expect(statuses).toEqual(["SUBSCRIBED"]);

    subscription.onEvent(event(2));
    expect(applied).toEqual([2]);

    await subscription.close();
    expect(transport.channelHandle.unsubscribed).toBe(true);
  });

  it("closes the channel when snapshot hydration fails", async () => {
    const transport = new BufferingTransport();
    const source: SnapshotSource = {
      fetchEventsAscending: async () => {
        throw new Error("snapshot failed");
      },
    };

    await expect(
      subscribe(GAME_ID, { transport, snapshotSource: source }),
    ).rejects.toThrow("snapshot failed");
    expect(transport.channelHandle.unsubscribed).toBe(true);
  });
});
