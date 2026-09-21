import { applyAuditArchive } from '../../adapters/audit-archive-database.mjs';

const [source, optionsJson, stageToHold] = process.argv.slice(2);
const options = JSON.parse(optionsJson);
if (stageToHold === 'never-send') await new Promise(() => { setInterval(() => {}, 1000); });
await applyAuditArchive(source, { ...options,
  async onStage(stage) {
    if (stage !== stageToHold) return;
    await new Promise((resolve, reject) => {
      process.send?.({ stage }, error => {
        if (error) reject(error);
        else setInterval(() => {}, 1000);
      });
    });
  },
});
