import { UsersService } from '../../src/modules/users/users.service';

/**
 * spec 015 US4 T017 — `openSession` / `closeSession`, the two admin-only
 * primitives from research R2, against a fake model so the eviction ordering
 * and the "no generation bump on close" guarantee are asserted in isolation.
 */

/** A Mongo update document, as recorded: one or more operators, each a field map. */
type RecordedUpdate = Record<string, Record<string, unknown>>;

interface FakeCalls {
  updateOne: { filter: unknown; update: RecordedUpdate; opts: unknown }[];
  findByIdAndUpdate: { id: unknown; update: RecordedUpdate; opts: unknown }[];
}

function fakeUserModel(doc: unknown) {
  const calls: FakeCalls = { updateOne: [], findByIdAndUpdate: [] };
  return {
    calls,
    findById: () => ({ session: () => ({ exec: async () => doc }) }),
    updateOne: (filter: unknown, update: RecordedUpdate, opts: unknown) => {
      calls.updateOne.push({ filter, update, opts });
      return { exec: async () => ({ acknowledged: true, modifiedCount: 1 }) };
    },
    findByIdAndUpdate: (id: unknown, update: RecordedUpdate, opts: unknown) => {
      calls.findByIdAndUpdate.push({ id, update, opts });
      return { exec: async () => ({ ...(doc as object), _id: id }) };
    },
  };
}

function makeService(doc: unknown) {
  const model = fakeUserModel(doc);
  const service = new UsersService(model as never, {} as never);
  return { service, model };
}

describe('UsersService admin session primitives (spec 015 R2)', () => {
  it('openSession appends the new session and evicts strictly the oldest by createdAt', async () => {
    const doc = {
      activeSessions: [
        { sid: 'a', createdAt: new Date(3000) },
        { sid: 'b', createdAt: new Date(1000) }, // oldest
        { sid: 'c', createdAt: new Date(2000) },
      ],
    };
    const { service, model } = makeService(doc);

    const { evictedSids } = await service.openSession('u1', 'new', 3, {} as never);

    expect(evictedSids).toEqual(['b']);
    const written = model.calls.updateOne[0].update.$set.activeSessions as { sid: string }[];
    expect(written.map((s) => s.sid)).toEqual(['c', 'a', 'new']);
    expect(written).toHaveLength(3);
  });

  it('openSession evicts nothing when there is room under the cap', async () => {
    const doc = { activeSessions: [{ sid: 'a', createdAt: new Date(1000) }] };
    const { service, model } = makeService(doc);

    const { evictedSids } = await service.openSession('u1', 'new', 3, {} as never);

    expect(evictedSids).toEqual([]);
    const written = model.calls.updateOne[0].update.$set.activeSessions as { sid: string }[];
    expect(written.map((s) => s.sid)).toEqual(['a', 'new']);
  });

  it('openSession can evict more than one when the cap was lowered below the current count', async () => {
    const doc = {
      activeSessions: [
        { sid: 'a', createdAt: new Date(1000) },
        { sid: 'b', createdAt: new Date(2000) },
        { sid: 'c', createdAt: new Date(3000) },
      ],
    };
    const { service } = makeService(doc);

    const { evictedSids } = await service.openSession('u1', 'new', 1, {} as never);

    expect(evictedSids).toEqual(['a', 'b', 'c']);
  });

  it('closeSession issues only a $pull and never touches sessionGeneration', async () => {
    const doc = { activeSessions: [{ sid: 'a', createdAt: new Date(1000) }], sessionGeneration: 4 };
    const { service, model } = makeService(doc);

    await service.closeSession('u1', 'a', {} as never);

    const call = model.calls.findByIdAndUpdate[0];
    expect(call.update).toEqual({ $pull: { activeSessions: { sid: 'a' } } });
    expect(JSON.stringify(call.update)).not.toContain('sessionGeneration');
    expect(JSON.stringify(call.update)).not.toContain('$inc');
  });

  it('openSession throws when the account is gone', async () => {
    const { service } = makeService(null);
    await expect(service.openSession('missing', 'new', 3, {} as never)).rejects.toThrow();
  });
});
