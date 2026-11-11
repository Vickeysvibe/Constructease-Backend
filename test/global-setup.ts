import { MongoMemoryReplSet } from "mongodb-memory-server";

let rs: MongoMemoryReplSet | undefined;

/** One in-memory replica set for the whole run (transactions need a replica set). */
export async function setup() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" }, binary: { version: "7.0.24" } });
  process.env.TEST_MONGODB_URI = rs.getUri("constructease_test");
}

export async function teardown() {
  await rs?.stop();
}
