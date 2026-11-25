// Explicit migration gate: disable global pointer/keyboard/focus mutation in
// candidate Core while keeping nonintrusive observation and per-target Workspace.
const GLOBAL_GUI_INPUT=new Set([
 'gui_mouse_move','gui_mouse_delta','gui_mouse_scroll','gui_mouse_click',
 'gui_mouse_drag','gui_type_text','gui_key_press','gui_focus_window'
]);
export function isTargetOnlyGui(config){
 return config?.workspaceControl?.targetScopedOnly===true;
}
export function exposedGuiTools(config,definitions){
 return !isTargetOnlyGui(config)?definitions:
  definitions.filter(d=>!GLOBAL_GUI_INPUT.has(d.name));
}
export function assertLegacyGuiPermitted(config,name,args={}){
 if(!isTargetOnlyGui(config))return;
 if(GLOBAL_GUI_INPUT.has(name)||
   (name==='gui_session_begin'&&args?.mode==='takeover')){
  const e=new Error('GUI_LEGACY_INPUT_RETIRED_USE_WORKSPACE_TARGET');
  e.code='GUI_LEGACY_INPUT_RETIRED_USE_WORKSPACE_TARGET';
  throw e;
 }
}
