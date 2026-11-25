import { registerPlugin } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { createMobileRepository } from "./mobileRepository.js";
import { createMobileStorage, MOBILE_SCHEMA } from "./mobileStorage.js";

const CalendarMobile = registerPlugin("CalendarMobile");
const sqlite = new SQLiteConnection(CapacitorSQLite);
let consistency;

async function nativeSql(operation) {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function openStorage(name, replica = false) {
  consistency ??= sqlite.checkConnectionsConsistency().catch((error) => {
    consistency = undefined;
    throw error;
  });
  await consistency;
  const { result: exists } = await sqlite.isConnection(name, false);
  const connection = exists
    ? await sqlite.retrieveConnection(name, false)
    : await sqlite.createConnection(name, false, "no-encryption", 1, false);
  try {
    const { result: isOpen } = await connection.isDBOpen();
    if (!isOpen) await connection.open();
    await connection.execute(MOBILE_SCHEMA);
  } catch (error) {
    await sqlite.closeConnection(name, false).catch(() => {});
    throw error;
  }
  return createMobileStorage({
    async query(statement, values) {
      const result = await nativeSql(() => connection.query(statement, values));
      return result.values ?? [];
    },
    write: (statements) => nativeSql(() => connection.executeSet(statements)),
    close: () => sqlite.closeConnection(name, false),
  }, { replica });
}

async function openProfile(origin, userId) {
  const key = new TextEncoder().encode(JSON.stringify([origin, userId]));
  const digest = await crypto.subtle.digest("SHA-256", key);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return nativeSql(() => openStorage(`energy_profile_${hash}`, true));
}

export function createNativeMobileRepository(version) {
  return createMobileRepository({
    native: CalendarMobile,
    openLocal: () => nativeSql(() => openStorage("energy_local")),
    openProfile,
    version,
    isForeground: () => document.visibilityState !== "hidden",
  });
}
