const fs = require('fs');
const path = require('path');
const workflowPath = path.resolve('n8n_ai_agent_diario_emocional.json');
const motorPath = path.resolve('motor_current.js');
const raw = fs.readFileSync(workflowPath, 'utf8').replace(/^\uFEFF/, '');
const workflow = JSON.parse(raw);
const code = fs.readFileSync(motorPath, 'utf8');
const node = workflow.nodes.find(n => n.name === 'Motor Diário Emocional');
if (!node) { console.error('Node not found'); process.exit(1); }
node.parameters.jsCode = code;
fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('✓ Correções sincronizadas no workflow JSON:');
console.log('  • downloadEvolutionMedia(): agora usa URL direta do audioMessage');
console.log('  • WAITING_CONTEXT: logs de debug adicionados');
console.log('  • WAITING_FREE_TEXT: logs de debug adicionados');
console.log('  • Retorna audio_status e error_debug na resposta');
