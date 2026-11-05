/** God window styles: calm, dark, translucent panels; motion at most 150 ms, no bounce (07 §0.1). */
export const GOD_CSS = `
:root{--bg:#04080c;--panel:rgba(7,15,21,.93);--panel2:rgba(12,24,32,.96);--line:rgba(120,190,210,.16);--line2:rgba(120,190,210,.3);
--text:#d3e7ee;--dim:#8fb0bb;--faint:#6f8c96;--accent:#62d2e8;--accent2:#9be7a8;--warn:#e8c06a;--bad:#ef8c72;--good:#8ee0a0;
--r:6px;--font:13px/1.45 system-ui,"Segoe UI",Roboto,sans-serif}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font:var(--font)}
*{box-sizing:border-box}
button,select,input,textarea{font:inherit;color:inherit}
button{background:rgba(98,210,232,.08);border:1px solid var(--line2);border-radius:5px;padding:4px 10px;min-height:28px;cursor:pointer;transition:background .12s,border-color .12s}
button:hover{background:rgba(98,210,232,.16);border-color:rgba(98,210,232,.5)}
button:focus-visible,select:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.on,button[aria-pressed=true]{background:rgba(98,210,232,.28);border-color:var(--accent);color:#fff}
button.primary{background:rgba(98,210,232,.24);border-color:var(--accent)}
button.danger{border-color:rgba(239,140,114,.6);background:rgba(239,140,114,.12)}
button:disabled{opacity:.45;cursor:default}
select,input[type=text],input[type=number],input[type=search],input[type=time],textarea{background:rgba(0,0,0,.35);border:1px solid var(--line2);border-radius:5px;padding:3px 7px;min-height:28px}
input[type=range]{accent-color:var(--accent);width:100%;min-height:22px}
.binomial{font-style:italic}
.dim{color:var(--dim)}.faint{color:var(--faint)}.warn{color:var(--warn)}.bad{color:var(--bad)}.good{color:var(--good)}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.grow{flex:1}.col{display:flex;flex-direction:column;gap:6px}
.sep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}
.pt-top{position:fixed;left:0;right:0;top:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 12px;white-space:nowrap;overflow:hidden;background:var(--panel);border-bottom:1px solid var(--line);z-index:20}
.pt-brand{font-weight:700;letter-spacing:.14em;font-size:12px;color:var(--accent)}
.pt-world{color:var(--dim)}
.pt-clock{font-variant-numeric:tabular-nums}
.pt-speed{flex-wrap:nowrap}.pt-speed button{min-width:40px;padding:3px 8px}
.pt-top>*{flex-shrink:0}.pt-top .pt-world,.pt-top .pt-clock{flex-shrink:1;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pt-top .ovn{max-width:220px;overflow:hidden;text-overflow:ellipsis}
@media (max-width:1400px){.pt-top .pt-world{display:none}.pt-top .ovn .lbl{display:none}}
.pt-status{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--good);display:inline-block}.dot.mock{background:var(--warn)}.dot.down{background:var(--bad)}
.pt-rail{position:fixed;left:0;top:44px;bottom:64px;width:76px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px;padding:6px 4px;z-index:19}
.pt-rail button{display:flex;flex-direction:column;align-items:center;gap:1px;border:1px solid transparent;background:transparent;padding:6px 2px;min-height:48px;font-size:11px;line-height:1.15;color:var(--dim);overflow-wrap:anywhere;text-align:center}
.pt-rail button .ico{font-size:17px;line-height:1;color:var(--text)}
.pt-rail button.on{background:rgba(98,210,232,.14);border-color:var(--line2);color:var(--text)}
.pt-panel{position:fixed;left:76px;top:44px;bottom:64px;width:420px;background:var(--panel);border-right:1px solid var(--line);z-index:18;display:flex;flex-direction:column;overflow:hidden}
.pt-panel.wide{right:0;width:auto;background:#060d13}
.pt-panel.mid{width:600px}
.pt-panel>header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.pt-panel>header h2{margin:0;font-size:14px;font-weight:600;flex:1}
.pt-panel>.body{flex:1;overflow:auto;padding:10px 12px}
.pt-insp{position:fixed;right:0;top:44px;bottom:64px;width:320px;background:var(--panel);border-left:1px solid var(--line);z-index:17;display:flex;flex-direction:column}
.pt-insp.collapsed{display:none}
.pt-insp header{padding:10px 12px;border-bottom:1px solid var(--line)}
.pt-insp .body{flex:1;overflow:auto;padding:10px 12px}
.tabs{display:flex;gap:2px;flex-wrap:wrap}.tabs button{padding:3px 8px;min-height:26px;font-size:12px}
.pt-time{position:fixed;left:0;right:0;bottom:0;height:64px;background:var(--panel);border-top:1px solid var(--line);z-index:20;display:flex;align-items:stretch}
.pt-time canvas{flex:1;min-width:0;cursor:pointer}
.pt-time .chips{display:flex;flex-direction:column;justify-content:center;gap:3px;padding:0 10px;border-left:1px solid var(--line)}
.chip{font-size:11px;padding:1px 8px;min-height:20px;border-radius:10px}
.pt-mini{position:fixed;left:88px;bottom:76px;width:224px;height:126px;border:1px solid var(--line2);border-radius:6px;overflow:hidden;z-index:16;background:rgba(0,0,0,.5)}
.pt-mini canvas{width:100%;height:100%;display:block;cursor:crosshair}
.ebar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--line2);border-radius:8px;padding:8px 14px;z-index:40;max-width:60vw;box-shadow:0 6px 30px rgba(0,0,0,.5)}
.pt-banner{position:fixed;left:50%;top:52px;transform:translateX(-50%);background:rgba(232,192,106,.14);border:1px solid rgba(232,192,106,.5);color:var(--warn);border-radius:6px;padding:4px 12px;z-index:21;font-size:12px}
.pt-count{position:fixed;left:50%;top:92px;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--warn);border-radius:8px;padding:8px 16px;z-index:22;font-size:15px;font-variant-numeric:tabular-nums}
.pt-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(520px,92vw);max-height:84vh;overflow:auto;background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:16px 18px;z-index:50;box-shadow:0 10px 60px rgba(0,0,0,.6)}
.pt-dialog h3{margin:0 0 10px;font-size:15px}
.pt-dialog .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.card{border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;background:rgba(255,255,255,.02)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px}.kv>:nth-child(odd){color:var(--dim)}
.bar{height:8px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent2)}
table.t{border-collapse:collapse;width:100%;font-size:12px}table.t td,table.t th{padding:2px 6px;border-bottom:1px solid var(--line);text-align:left}table.t th{color:var(--dim);font-weight:500}
table.t td.num{text-align:right;font-variant-numeric:tabular-nums}
.pgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.pgrid button{display:flex;flex-direction:column;align-items:center;padding:6px 2px;min-height:56px;font-size:11px}
.pgrid button .ico{font-size:19px}
.pgrid button.major{border-color:rgba(239,140,114,.45)}
.hold{position:relative;overflow:hidden}.hold>i{position:absolute;left:0;top:0;bottom:0;background:rgba(239,140,114,.35);pointer-events:none}
.snap{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:7px 0;border-bottom:1px solid var(--line)}
.snap .meta{font-size:11px;color:var(--dim)}
.issue{display:flex;gap:6px;align-items:flex-start;font-size:12px;padding:2px 0;cursor:pointer}
.sev{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:0 5px;border-radius:3px;border:1px solid}
.sev.info{color:var(--accent);border-color:var(--line2)}.sev.warning{color:var(--warn);border-color:rgba(232,192,106,.5)}.sev.inviable{color:var(--bad);border-color:rgba(239,140,114,.6)}
/* designer */
.dz{display:grid;grid-template-columns:150px minmax(320px,1fr) minmax(300px,420px);grid-template-rows:minmax(0,1fr) auto;height:100%}
.dz .groups{border-right:1px solid var(--line);overflow:auto;padding:8px 0}
.dz .groups button{display:block;width:100%;text-align:left;border:0;border-radius:0;background:transparent;padding:5px 14px;min-height:28px;color:var(--dim)}
.dz .groups button.on{background:rgba(98,210,232,.12);color:var(--text);box-shadow:inset 2px 0 var(--accent)}
.dz .mid{overflow:auto;padding:8px 14px}
.dz .side{border-left:1px solid var(--line);overflow:auto;padding:8px 12px;display:flex;flex-direction:column;gap:10px}
.dz .foot{grid-column:1/-1;border-top:1px solid var(--line);padding:8px 14px;display:grid;grid-template-columns:1.4fr 1fr;gap:16px;max-height:190px;overflow:auto}
.slider{display:grid;grid-template-columns:150px 1fr 92px;gap:8px;align-items:center;padding:3px 0}
.slider label{font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slider .val{font-size:12px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.slider.hl{background:rgba(232,192,106,.1);border-radius:4px}
.subhead{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:10px 0 4px}
.ro-chip{display:inline-block;font-size:12px;padding:2px 8px;border:1px dashed var(--line2);border-radius:10px;color:var(--dim);margin:2px 4px 2px 0;cursor:pointer;background:none}
.ebar{display:grid;grid-template-columns:120px 1fr 80px;gap:6px;align-items:center;font-size:12px}
.ebar .b{height:10px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;display:flex}
.ebar .b>i{display:block;height:100%}
.lib-row{display:grid;grid-template-columns:96px 1fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.lib-row canvas{width:96px;height:64px;background:#02060a;border-radius:4px}
.host-down .pt-speed button,.host-down .pgrid button,.host-down .dhead button.primary,.host-down .dhead button.danger,.host-down .snap button,.host-down .pt-panel .card button.danger{pointer-events:none;opacity:.4}
.dhead{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
`;
export const GOD_CSS2 = `
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button.small{min-height:24px;padding:1px 7px;font-size:12px}
button.ghost{background:transparent;border-color:transparent;color:var(--dim)}button.ghost:hover{border-color:var(--line2);color:var(--text)}
td button.ghost{margin-left:4px;min-height:22px;padding:0 5px}
fieldset.kgroup{border:1px solid var(--line);border-radius:var(--r);padding:6px 10px 8px;margin:10px 0 0;display:flex;flex-direction:column;gap:2px}
fieldset.kgroup legend{padding:0 4px;color:var(--dim);font-size:12px;letter-spacing:.04em}
h3.sub{margin:16px 0 2px;font-size:14px}
.knob{display:grid;grid-template-columns:minmax(120px,1fr) minmax(100px,1.3fr) 70px 30px;gap:6px;align-items:center;min-height:30px}
.knob label{font-size:12px}.knob .val{font-size:12px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.knob .khint{grid-column:1/-1;font-size:11px;margin-top:-4px;min-height:0}.knob .khint:empty{display:none}
.knob select,.knob input[type=number],.knob input[type=text]{min-width:0;width:100%}
.kreset{min-height:26px;padding:0 6px}
.pt-help{width:28px;height:28px;min-height:28px;padding:0;border-radius:50%;font-weight:700}
.pt-onb{position:fixed;left:0;right:0;bottom:76px;display:flex;justify-content:center;pointer-events:none;z-index:30}
.pt-onb .onb-card{pointer-events:auto;background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:14px 16px;max-width:min(520px,92vw);box-shadow:0 10px 50px rgba(0,0,0,.55)}
.pt-onb .onb-card h2{margin:0 0 6px;font-size:16px}.pt-onb .onb-card p{margin:0 0 10px}
.pt-onb .onb-card.small{padding:8px 14px;color:var(--dim)}
.pt-onb .coach-card{display:flex;flex-direction:column;gap:6px;border-color:var(--warn)}
.pt-onb .coach-card.pinned{position:fixed;max-width:300px}
.coach-target{outline:2px solid var(--warn)!important;outline-offset:2px;box-shadow:0 0 0 6px rgba(232,192,106,.18)!important}
html.hc{--panel:#000;--panel2:#000;--line:rgba(255,255,255,.45);--line2:rgba(255,255,255,.8);--text:#fff;--dim:#e6eef0;--faint:#c8d4d8;--accent:#7fe3f5;--warn:#ffd77a;--bad:#ff9f86;--good:#a8f0b8}
html.hc button{background:#000;border-color:var(--line2)}html.hc button.on,html.hc button[aria-pressed=true]{background:#0b4552}
html.hc .pt-toast,html.hc .pt-dialog,html.hc .pt-onb .onb-card{box-shadow:none}
html.reduced *{transition:none!important;animation:none!important}
.pt-rail button{overflow-wrap:normal;word-break:normal;hyphens:auto;-webkit-hyphens:auto;font-size:10.5px}
.dz .slider{grid-template-columns:minmax(150px,190px) 1fr 92px}
.onb-on .pt-toast{bottom:auto;top:96px}
.pt-describe{position:fixed;right:12px;bottom:76px;z-index:16}
.pt-insp.collapsed~.pt-rail button{overflow-wrap:normal;word-break:normal;hyphens:auto;-webkit-hyphens:auto;font-size:10.5px}
.dz .slider{grid-template-columns:minmax(150px,190px) 1fr 92px}
.onb-on .pt-toast{bottom:auto;top:96px}
.pt-describe{right:12px}
`;
