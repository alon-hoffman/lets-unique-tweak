/** Resolve a focused inspector from the current Ink Skater checkout, never a copied game. */
import fs from 'node:fs';
import path from 'node:path';
export function inkSkaterDefinition(project) {
  const file='src/game/physicsConfig.ts', source=fs.readFileSync(path.join(project,file),'utf8');
  const param=(id,label,key,min,max,step,hint)=>{
    const match=new RegExp('^\\s*'+key+':\\s*(-?\\d+(?:\\.\\d+)?)','m').exec(source);
    if(!match)throw new Error(`Cannot locate unique Ink Skater setting ${key}; rediscover the current source.`);
    return {id,label,group:'Ink Skater · movement',file,line:source.slice(0,match.index).split('\n').length,literal:match[1],min,max,step,hint};
  };
  return {scope:'Ink Skater movement',title:'Ink Skater · movement',summary:'Real physicsConfig.ts values. Source changes go through Tweak; Vite may reload the game and reset your run.',params:[
    param('gravity','Gravity','gravity',400,3200,50,'px/s² · engine gravity is initialized when Simulation is constructed; reload/new instance required.'),
    param('propulsion','Ground acceleration','propulsion',100,1500,20,'px/s² · evaluated each tick; module reload behavior still depends on Vite.'),
    param('cruise','Cruise speed','cruiseSpeed',100,700,10,'px/s · evaluated each tick; compare on the same level.'),
    param('tilt','Air tilt acceleration','tiltAcceleration',2,40,1,'rad/s² · evaluated each tick.'),
    param('groundTilt','Ground tilt acceleration','groundTiltAcceleration',20,140,5,'rad/s² · evaluated each tick.'),
  ]};
}
