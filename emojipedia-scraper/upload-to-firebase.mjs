import fs from "node:fs/promises";
import path from "node:path";
import admin from "firebase-admin";

// --- EDIT THIS ---
const DATABASE_URL = "https://appledata-8cc22-default-rtdb.firebaseio.com/"; // paste your databaseURL

// Path to your files
const DATA_PATH = path.resolve("apple_emojis.json");
const SERVICE_ACCOUNT_PATH = path.resolve("service-account.json");

// Init Firebase Admin
const serviceAccount = JSON.parse(await fs.readFile(SERVICE_ACCOUNT_PATH, "utf8"));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL,
});

const db = admin.database();

/**
 * Writes the JSON to /emojipedia/apple_emojis
 * - If you want to merge instead of overwrite, use .update() below.
 */
async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const ref = db.ref("/emojipedia/apple_emojis");

  // Overwrite everything at that path:
  await ref.set(data);

  // If you prefer a non-destructive merge, comment .set() above and use:
  // await ref.update(data);

  console.log(`✅ Uploaded ${Object.keys(data).length} records to /emojipedia/apple_emojis`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
