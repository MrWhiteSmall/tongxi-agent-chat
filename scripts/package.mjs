import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [out] = await packager({
  dir: '.', name: 'Tongxi', executableName: 'Tongxi', appBundleId: 'local.tongxi.agentchat',
  ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
  platform: 'darwin', arch: process.arch, out: 'dist', overwrite: true,
  ignore: [/^\/(dist|data|test|node_modules|\.git)(\/|$)/, /^\/\.env/, /^\/package-lock\.json$/]
});
const app = join(out, 'Tongxi.app');
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, 'dist/Tongxi-mac-' + process.arch + '.zip']);
console.log(out);
