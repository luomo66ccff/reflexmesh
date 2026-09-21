process.on('disconnect', () => process.exit(0));
process.on('message', () => { setInterval(() => {}, 1000); });
