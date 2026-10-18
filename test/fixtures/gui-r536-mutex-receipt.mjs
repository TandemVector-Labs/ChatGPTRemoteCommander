import readline from 'node:readline';
const mode = process.argv[2] ?? 'oneshot';
const variant = process.argv[3] ?? 'valid';
const variants = {
  valid: {ok:false,error:'GUI_NATIVE_BUSY',submission:'NOT_SUBMITTED'},
  missing: {ok:false,error:'GUI_NATIVE_BUSY'},
  extra: {ok:false,error:'GUI_NATIVE_BUSY',submission:'NOT_SUBMITTED',extra:true},
  forged: {ok:false,error:'GUI_NATIVE_FAILED',submission:'NOT_SUBMITTED'},
  wrong: {ok:false,error:'GUI_NATIVE_BUSY',submission:'SUBMITTED'},
  success: {ok:true,available:true}
};
const reply = () => process.stdout.write(JSON.stringify(variants[variant])+'\n');
if (mode === 'persistent') {
  process.stdout.write('{"ok":true,"ready":true,"protocol":1}\n');
  for await (const _ of readline.createInterface({input:process.stdin})) reply();
} else {
  for await (const _ of readline.createInterface({input:process.stdin})) reply();
}
