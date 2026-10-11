// MongoDB initialization script for CodeCollab (SEC-INFRA-01)
// Executed by mongo:6 entrypoint only on first initialization of an empty data volume.

const appDatabase = 'codecollab';
const appUser = process.env.MONGO_APP_USER || 'codecollab_app';
const appPassword = process.env.MONGO_APP_PASSWORD;

if (appPassword) {
  const dbInstance = db.getSiblingDB(appDatabase);
  dbInstance.createUser({
    user: appUser,
    pwd: appPassword,
    roles: [
      { role: 'readWrite', db: appDatabase }
    ]
  });
  print(`[mongo-init] Successfully created application user '${appUser}' on '${appDatabase}'`);
} else {
  print('[mongo-init] Notice: MONGO_APP_PASSWORD not provided in environment; skipped app user creation.');
}
