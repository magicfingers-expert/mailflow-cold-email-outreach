// MailFlow Automated Test Suite Runner
// Discovers and executes all unit and integration tests

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const testDirs = [
  path.join(__dirname, 'unit'),
  path.join(__dirname, 'integration')
];

const testFiles = [];

testDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(file => {
      if (file.endsWith('.test.js')) {
        testFiles.push(path.join(dir, file));
      }
    });
  }
});

console.log('========================================================');
console.log('🧪 MAILFLOW AUTOMATED TEST SUITE');
console.log(`📋 Found ${testFiles.length} test files:`);
testFiles.forEach(f => console.log(`   • ${path.relative(__dirname, f)}`));
console.log('========================================================\n');

const child = spawn(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, VERCEL: '1', MAILFLOW_TEST_MODE: '1' }
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\n========================================================');
    console.log('✅ ALL TEST SUITES PASSED CLEANLY');
    console.log('========================================================');
    process.exit(0);
  } else {
    console.error('\n========================================================');
    console.error(`❌ TEST SUITE FAILED WITH EXIT CODE ${code}`);
    console.error('========================================================');
    process.exit(code);
  }
});
