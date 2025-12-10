import React, { useState, useEffect, useMemo, useRef } from 'react'

/* =========================
 * Helpers, caches, constants
 * ========================= */
const scoreCache = new Map()
const metersCache = new Map()
const CORE_FIELDS = new Set(['id','firstname','lastname','gender','tags','notes','previousteacher','previous_teacher', 'name'])
const norm = (s)=> String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')

const VERSION = 'v2.0.8'
const BUILTIN_TAGS = ['504','IEP','ELL','Gifted','Speech']

const WEIGHT_MAP = {
  'Low': 0.5,
  'Normal': 1.0,
  'High': 2.0,
  0.5: 'Low',
  1.0: 'Normal',
  2.0: 'High'
};

const LETTER_GRADE_MAP = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    map[letter] = i + 1;
  }
  return map;
})();

function makeCriteriaVersion(criteria){
  return criteria.map(c=>`${c.label}:${c.weight}:${c.max}:${c.enabled}`).join('|')
}

function getCompositeScore(studentsById, id, criteria, cv){
  const key = id + '|' + cv
  const cached = scoreCache.get(key)
  if (cached !== undefined) return cached

    const s = studentsById.get(id)
    if (!s) {
      scoreCache.set(key, 0)
      return 0
    }

    if (s.ignoreScores) {
      scoreCache.set(key, 0);
      return 0;
    }

    // NORMALIZATION FIX:
    const val = criteria.reduce((acc, c) => {
      const rawValue = Number(s.criteria?.[c.label]) || 0
      const weight = Number(c.weight) || 0
      // Prevent division by zero; default to 100 if max is missing/zero
      const maxScore = c.max > 0 ? c.max : 100

      // 1. Convert to percentage (0.0 to 1.0)
      // 2. Multiply by 100 to get a nice whole number scale
      // 3. Apply the Importance Weight
      const normalizedScore = (rawValue / maxScore) * 100

      return acc + (normalizedScore * weight)
    }, 0)

    scoreCache.set(key, val)
    return val
}

function getAverageCriteriaScore(studentsById, allIds, criterionLabel) {
  const relevantIds = allIds.filter(id => !studentsById.get(id)?.ignoreScores);
  if (relevantIds.length === 0) return 0;
  const totalScore = relevantIds.reduce((sum, id) => {
    return sum + (Number(studentsById.get(id)?.criteria?.[criterionLabel]) || 0);
  }, 0);
  return totalScore / relevantIds.length;
}

function calcMeters(cls, studentsById, criteria, allIds, cv){
  const rosterSig = cls.studentIds.join(',')
  const key = `${cls.id}|${cv}|${rosterSig}`
  const cached = metersCache.get(key)
  if(cached) return cached

    const calculatedStudents = cls.studentIds.filter(id => !studentsById.get(id)?.ignoreScores);
  const calculatedStudentCount = calculatedStudents.length;
  const activeCriteria = criteria.filter(c => c.enabled);

  const meters = activeCriteria.map(c=>{
    let avg = 0;
    if (calculatedStudentCount > 0) {
      const totalCriteriaScore = calculatedStudents.reduce((sum, id) => {
        return sum + (Number(studentsById.get(id)?.criteria?.[c.label]) || 0);
      }, 0);
      avg = totalCriteriaScore / calculatedStudentCount;
    }

    const pct = Math.max(0, Math.min(100, (avg/(c.max||100))*100))
    const globalAvg = getAverageCriteriaScore(studentsById, allIds, c.label);
    const deviation = avg - globalAvg;
    const deviationPct = (deviation / (globalAvg || 1)) * 100;

    let colorClass = 'bg-emerald-500';
    let labelText = 'Balanced';

  if (deviation < 0) {
    if (deviationPct <= -15) {
      colorClass = 'bg-rose-500';
      labelText = 'Far Below Average';
    } else if (deviationPct <= -10) {
      colorClass = 'bg-amber-500';
      labelText = 'Below Average';
    }
  } else if (deviation > 0) {
    if (deviationPct >= 10) {
      colorClass = 'bg-indigo-500';
      labelText = 'Above Average';
    }
  }

  return { label:c.label, pct, colorClass, avg, globalAvg, labelText };
  })
  metersCache.set(key, meters); return meters
}

function stats(studentsById, ids){
  const n = ids.length
  let F=0, M=0
  ids.forEach(id=>{ const g=studentsById.get(id)?.gender; if(g==='F') F++; else if(g==='M') M++; })
  return { size:n, F, M }
}

function pickByGenderImbalance (candidateIndexes, unitIds, classes, studentsById) {
  let best = candidateIndexes[0], bestScore = Infinity
  for(const i of candidateIndexes){
    const ids = classes[i].studentIds
    let M=0, F=0
    for(const id of ids){
      const g = studentsById.get(id)?.gender
      if(g==='M') M++; else if(g==='F') F++
    }
    const gNew = unitIds.map(id => studentsById.get(id)?.gender).reduce((acc, g) => {
      if(g==='M') acc.M++; else if(g==='F') acc.F++
        return acc
    }, {M:0, F:0})

    const sc = Math.abs((M+gNew.M) - (F+gNew.F))
    if(sc < bestScore){ bestScore = sc; best = i }
  }
  return best
}

function autoPlace(studentsById, allIds, n, { criteria, keepTogetherPairs, keepApartPairs, classMeta }){
  const classes = Array.from({length:n},(_,i)=>{
    const meta = classMeta?.[i] || {}
    return { id:`Class ${i+1}`, name: meta.name || `Class ${i+1}`, studentIds:[] }
  })
  const targetBase = Math.floor(allIds.length / n)
  const remainder = allIds.length % n
  const capacity = classes.map((_,i)=> targetBase + (i < remainder ? 1 : 0))

  const pinMap = new Map()
  allIds.forEach(id=>{
    const pc = studentsById.get(id)?.pinClass
    if(Number.isInteger(pc) && pc>=0 && pc<n) pinMap.set(id, pc)
  })

  const parent = new Map(allIds.map(id=>[id,id]))
  const find = (x)=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra, rb) }
  for(const [a,b] of keepTogetherPairs){ if(a && b) union(a,b) }

  const comps = new Map()
  allIds.forEach(id => { const r=find(id); if(!comps.has(r)) comps.set(r, []); comps.get(r).push(id) })

  const units = []
  for(const comp of comps.values()){
    const byPin = new Map()
    for(const id of comp){
      const p = pinMap.get(id)
      const key = p == null ? 'free' : `p${p}`
      if(!byPin.has(key)) byPin.set(key, [])
        byPin.get(key).push(id)
    }
    const pinnedKeys = [...byPin.keys()].filter(k=>k!=='free')
    if(pinnedKeys.length === 1){
      const pinKey = pinnedKeys[0]
      const pIdx = Number(pinKey.slice(1))
      const whole = comp.slice()
      whole.forEach(id => pinMap.set(id, pIdx))
      units.push({ ids: whole, target: pIdx })
    }else if(pinnedKeys.length > 1){
      for(const k of pinnedKeys){
        const chunk = byPin.get(k)
        const pIdx = Number(k.slice(1))
        chunk.forEach(id => pinMap.set(id, pIdx))
        units.push({ ids: chunk.slice(), target: pIdx })
      }
      if(byPin.has('free')) units.push({ ids: byPin.get('free').slice(), target: null })
    }else{
      units.push({ ids: comp.slice(), target: null })
    }
  }

  const apartSet = new Set(keepApartPairs.map(([a,b])=>`${a}|${b}`))
  const cv = makeCriteriaVersion(criteria)
  const avgScore = (ids)=> ids.reduce((a,id)=>a+(getCompositeScore(studentsById,id,criteria,cv)),0)/ids.length

  const pinnedUnits = units.filter(u=>u.target!=null)
  const freeUnits   = units.filter(u=>u.target==null).sort((u,v)=> avgScore(v.ids)-avgScore(u.ids))

  const fitsClass = (unit, ci)=> classes[ci].studentIds.length + unit.ids.length <= capacity[ci]
  const violatesApartUnit = (unit, ci)=> {
    const dst = classes[ci].studentIds
    for(const u of unit.ids){ for(const x of dst){
      if(apartSet.has(`${u}|${x}`) || apartSet.has(`${x}|${u}`)) return true
    }} return false
  }

  const classAvgAfter = (ci, unitIds) => {
    const existingRelevantIds = classes[ci].studentIds.filter(id => !studentsById.get(id)?.ignoreScores);
    const incomingRelevantIds = unitIds.filter(id => !studentsById.get(id)?.ignoreScores);
    const currentN = existingRelevantIds.length;
    const incomingN = incomingRelevantIds.length;
    if (currentN + incomingN === 0) return 0;
    const currentTotal = existingRelevantIds.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv), 0);
    const addTotal = incomingRelevantIds.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv), 0);
    return (currentTotal + addTotal) / (currentN + incomingN);
  }

  const pickByClassNeedThenGender = (candidateIndexes, unitIds) => {
    let best = []; let bestVal = Infinity
    for (const i of candidateIndexes) {
      const val = classAvgAfter(i, unitIds)
      if (val < bestVal - 1e-6) { bestVal = val; best = [i] }
      else if (Math.abs(val - bestVal) <= 0.25) { best.push(i) }
    }
    if (best.length === 1) return best[0]
      return pickByGenderImbalance(best, unitIds, classes, studentsById)
  }

  for(const unit of pinnedUnits){
    const ci = unit.target
    if(!violatesApartUnit(unit, ci)){
      classes[ci].studentIds.push(...unit.ids)
    }else{
      const sorted = classes.map((c,i)=>({i, size:c.studentIds.length})).sort((a,b)=>a.size-b.size).map(x=>x.i)
      const viable = sorted.filter(i => fitsClass(unit, i) && !violatesApartUnit(unit, i))
      if(viable.length){
        const chosen = pickByClassNeedThenGender(viable, unit.ids)
        classes[chosen].studentIds.push(...unit.ids)
      }else{
        classes[ci].studentIds.push(...unit.ids)
      }
    }
  }

  for(const unit of freeUnits){
    const sizes = classes.map(c=>c.studentIds.length)
    const minSize = Math.min(...sizes)
    let candidates = sizes.map((sz,i)=> (sz===minSize? i : null)).filter(i=>i!==null).filter(i => fitsClass(unit,i) && !violatesApartUnit(unit,i))
    if(!candidates.length){
      const sorted = classes.map((c,i)=>({i, size:c.studentIds.length})).sort((a,b)=>a.size-b.size).map(x=>x.i)
      candidates = sorted.filter(i => !violatesApartUnit(unit,i))
      if(!candidates.length) candidates = sorted
    }
    const chosen = pickByClassNeedThenGender(candidates, unit.ids)
    classes[chosen].studentIds.push(...unit.ids)
  }

  const seen = new Set()
  for (const c of classes) {
    c.studentIds = c.studentIds.filter(id => {
      if (seen.has(id)) return false
        seen.add(id); return true
    })
  }
  return { classes, capacity }
}

function leveledPlace(studentsById, allIds, n, { criteria, levelOn, keepTogetherPairs, keepApartPairs, classMeta }){
  const classes = Array.from({length:n},(_,i)=>{
    const meta = classMeta?.[i] || {}
    return { id:`Class ${i+1}`, name: meta.name || `Class ${i+1}`, studentIds:[] }
  })
  const targetBase = Math.floor(allIds.length / n)
  const remainder = allIds.length % n
  const capacity = classes.map((_,i)=> targetBase + (i < remainder ? 1 : 0))

  const pinMap = new Map()
  allIds.forEach(id=>{
    const pc = studentsById.get(id)?.pinClass
    if(Number.isInteger(pc) && pc>=0 && pc<n) pinMap.set(id, pc)
  })
  const parent = new Map(allIds.map(id=>[id,id]))
  const find = (x)=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra, rb) }
  for(const [a,b] of keepTogetherPairs){ if(a && b) union(a,b) }
  const comps = new Map()
  allIds.forEach(id => { const r=find(id); if(!comps.has(r)) comps.set(r, []); comps.get(r).push(id) })

  const units = []
  for(const comp of comps.values()){
    const byPin = new Map()
    for(const id of comp){
      const p = pinMap.get(id)
      const key = p == null ? 'free' : `p${p}`
      if(!byPin.has(key)) byPin.set(key, [])
        byPin.get(key).push(id)
    }
    const pinnedKeys = [...byPin.keys()].filter(k=>k!=='free')
    if(pinnedKeys.length === 1){
      const pinKey = pinnedKeys[0]
      const pIdx = Number(pinKey.slice(1))
      const whole = comp.slice()
      whole.forEach(id => pinMap.set(id, pIdx))
      units.push({ ids: whole, target: pIdx })
    }else if(pinnedKeys.length > 1){
      for(const k of pinnedKeys){
        const chunk = byPin.get(k)
        const pIdx = Number(k.slice(1))
        chunk.forEach(id => pinMap.set(id, pIdx))
        units.push({ ids: chunk.slice(), target: pIdx })
      }
      if(byPin.has('free')) units.push({ ids: byPin.get('free').slice(), target: null })
    }else{
      units.push({ ids: comp.slice(), target: null })
    }
  }

  const apartSet = new Set(keepApartPairs.map(([a,b])=>`${a}|${b}`))
  const violatesApartUnit = (unit, ci)=>{
    const dst = classes[ci].studentIds
    for(const u of unit.ids){ for(const x of dst){
      if(apartSet.has(`${u}|${x}`) || apartSet.has(`${x}|${u}`)) return true
    }} return false
  }
  const fitsClass = (unit, ci)=> classes[ci].studentIds.length + unit.ids.length <= capacity[ci]

  const cv = makeCriteriaVersion(criteria)
  const scoreOf = (id) => {
    if (levelOn === 'Composite') return getCompositeScore(studentsById, id, criteria, cv)
      return Number(studentsById.get(id)?.criteria?.[levelOn]) || 0
  }
  const unitScore = (ids)=> ids.reduce((t,id)=> t + scoreOf(id), 0) / (ids.length || 1)

  const pinnedUnits = units.filter(u=>u.target!=null)
  const freeUnits   = units.filter(u=>u.target==null)
  freeUnits.sort((a,b)=> unitScore(b.ids) - unitScore(a.ids))

  for(const unit of pinnedUnits){
    const ci = unit.target
    if(!violatesApartUnit(unit, ci)){
      classes[ci].studentIds.push(...unit.ids)
    } else {
      const order = [...Array(n).keys()]
      let placed=false
      for(const alt of order){
        if(fitsClass(unit, alt) && !violatesApartUnit(unit, alt)) { classes[alt].studentIds.push(...unit.ids); placed=true; break }
      }
      if(!placed) classes[ci].studentIds.push(...unit.ids)
    }
  }

  let currentClassIndex = 0;
  for(const unit of freeUnits){
    let placed = false;
    for (let i = currentClassIndex; i < n; i++) {
      if (fitsClass(unit, i) && !violatesApartUnit(unit, i)) {
        classes[i].studentIds.push(...unit.ids);
        currentClassIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const order = [...Array(n).keys()].sort((a,b)=>a-b);
      for(const alt of order){
        if(fitsClass(unit, alt) && !violatesApartUnit(unit, alt)) { classes[alt].studentIds.push(...unit.ids); placed=true; break }
      }
      if(!placed) classes[currentClassIndex].studentIds.push(...unit.ids)
    }
    if (classes[currentClassIndex].studentIds.length >= capacity[currentClassIndex] && currentClassIndex < n - 1) {
      currentClassIndex++;
    }
  }

  const seen = new Set()
  for (const c of classes) {
    c.studentIds = c.studentIds.filter(id => {
      if (seen.has(id)) return false
        seen.add(id); return true
    })
  }
  return { classes, capacity }
}

function safeParseCSV(text){
  const raw = String(text||'').replace(/^\uFEFF/,'')
  const lines = raw.split(/\r\n|\n|\r/).filter(l=>l && l.trim().length > 0)
  if(!lines.length) return {students:[],criteriaLabels:[], maxScores:{}}

  const headersRaw = splitCSV(lines[0].trim()).map(h=>h.trim())
  const headersNorm = headersRaw.map(h=>norm(h))
  const hasSingleName = headersNorm.includes('name')

  const body = lines.slice(1);
  const rows = body.map(splitCSV);
  const colCells = headersRaw.map((_,i)=> rows.map(r=>r[i]??''))
  const coreFieldsSet = new Set(['id', 'firstname', 'lastname', 'name', 'gender', 'tags', 'notes', 'previousteacher', 'previous_teacher'])
  const criteriaLabels = headersRaw.filter((h,i)=> !coreFieldsSet.has(headersNorm[i]) && mostlyNumeric(colCells[i]||[]) )

  const maxScores = {}
  const parsedCriteriaValues = new Map()

  criteriaLabels.forEach(label => {
    const columnIndex = headersRaw.findIndex(h => h.trim() === label);
    let max = 0;
    const values = [];
    if (columnIndex !== -1) {
      rows.forEach(row => {
        const rawValue = (row[columnIndex] || '').trim();
        let value = 0;
        if (rawValue) {
          const numValue = parseFloat(rawValue);
          if (!isNaN(numValue)) {
            value = numValue;
          } else {
            value = LETTER_GRADE_MAP[rawValue.toUpperCase()] || 0;
          }
        }
        values.push(value);
        if (value > max) max = value;
      });
    }
    maxScores[label] = max > 0 ? max : 100;
    parsedCriteriaValues.set(label, values);
  });

  const students=[]
  for(let r=0;r<rows.length;r++){
    const cols=rows[r];
    const byNorm={};
    headersNorm.forEach((hn,i)=> byNorm[hn] = (cols[i]??'').trim());

    const hasNameData = byNorm['firstname'] || byNorm['lastname'] || byNorm['name'];
    if (!hasNameData) continue;

    const crit={};
    criteriaLabels.forEach(label=>{
      crit[label] = parsedCriteriaValues.get(label)[r];
    });

    const previousTeacher = byNorm['previousteacher'] || byNorm['previous_teacher'] || ''
    let firstName = byNorm['firstname'] || '';
    let lastName = byNorm['lastname'] || '';

    if (!firstName && !lastName && hasSingleName && byNorm['name']) {
      const parts = byNorm['name'].split(/\s+/);
      firstName = parts.shift() || '';
      lastName = parts.join(' ') || '';
    }

    let idValue = byNorm['id'];
    if (!idValue) {
      const baseNameId = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
      idValue = baseNameId || `row${r + 1}`;
    }

    students.push({
      id: idValue,
      firstName: firstName,
      lastName: lastName,
      name: `${firstName} ${lastName}`.trim(),
                  gender:byNorm['gender']||undefined,
                  criteria:crit,
                  tags:(byNorm['tags']||'').split(/[|,;/]/).map(x=>x.trim()).filter(Boolean),
                  notes:byNorm['notes']||'',
                  previousTeacher,
                  ignoreScores: false,
    })
  }
  return { students, criteriaLabels, maxScores }
}

function splitCSV(str){
  const res=[]
  let cur=''; let inQ=false
  for(let i=0;i<str.length;i++){
    const c=str[i]
    if(inQ){
      if(c==='"'){
        if(i+1<str.length && str[i+1]==='"'){ cur+='"'; i++ }
        else inQ=false
      } else cur+=c
    } else {
      if(c==='"') inQ=true
        else if(c===',') { res.push(cur.trim()); cur='' }
        else cur+=c
    }
  }
  res.push(cur.trim())
  return res
}
function mostlyNumeric(vals){
  let num=0, tot=0
  for(const v of vals){
    if(!v) continue
      tot++
      if(!isNaN(parseFloat(v))) num++
  }
  return tot>0 && (num/tot > 0.6)
}

function pickClassForNewStudentBalanced(sid, classes, studentsById, criteria, cv){
  const scores = classes.map((c,i)=>{
    const ids = c.studentIds
    const sum = ids.reduce((acc,id)=> acc + getCompositeScore(studentsById,id,criteria,cv), 0)
    const avg = ids.length ? sum/ids.length : 0
    return { i, avg, count: ids.length }
  })
  scores.sort((a,b)=> a.avg - b.avg)
  return scores[0].i
}

function pickClassForNewStudentLeveled(sid, classes, studentsById, criteria, cv, levelOn){
  const sScore = (levelOn==='Composite')
  ? getCompositeScore(studentsById, sid, criteria, cv)
  : (Number(studentsById.get(sid)?.criteria?.[levelOn])||0)

  let bestI = 0, bestDiff = Infinity
  classes.forEach((c,i)=>{
    const ids = c.studentIds
    if(!ids.length){
      if(bestDiff > Infinity) { bestDiff=Infinity; bestI=i }
    } else {
      let sum=0
      ids.forEach(x=>{
        const val = (levelOn==='Composite')
        ? getCompositeScore(studentsById, x, criteria, cv)
        : (Number(studentsById.get(x)?.criteria?.[levelOn])||0)
        sum+=val
      })
      const avg = sum/ids.length
      const diff = Math.abs(avg - sScore)
      if(diff < bestDiff){ bestDiff = diff; bestI = i }
    }
  })
  return bestI
}

/* =========================
 * UI: Modal
 * ========================= */
function Modal({ open, onClose, title, children }) {
  if (!open) return null
    return (
      <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm transition-opacity"
      onClick={onClose}
      >
      <div
      className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[min(700px,92vw)] max-h-[86vh] overflow-auto border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95 duration-200"
      onClick={(e)=>e.stopPropagation()}
      >
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
      <div className="font-bold text-lg text-slate-800 dark:text-white">{title}</div>
      <button className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-600 transition" onClick={onClose}>Close</button>
      </div>
      <div className="p-6">{children}</div>
      </div>
      </div>
    )
}

/* =========================
 * Manual Pins sub-component
 * ========================= */
function ManualPins({ allIds, studentsById, numClasses, setStudentsById, classes, setBlockedMoveMessage }){
  const [selectedId, setSelectedId] = useState('')
  const [constraintSearch, setConstraintSearch] = useState('');

  useEffect(()=>{
    if (selectedId && !allIds.includes(selectedId)) setSelectedId('');
  }, [allIds, selectedId])

  const s = selectedId ? studentsById.get(selectedId) : null
  const sortedIds = useMemo(()=> [...allIds].sort((a,b)=> (studentsById.get(a)?.name||'').localeCompare(studentsById.get(b)?.name||'')), [allIds, studentsById])

  function batchPatchStudents(updates){
    setStudentsById(prev=>{
      const m=new Map(prev);
      updates.forEach(({id, patch}) => {
        m.set(id, { ...m.get(id), ...patch });
      });
      return m
    })
  }

  function patchStudent(id, patch){
    batchPatchStudents([{id, patch}]);
  }

  const togglePin = (type, targetId) => {
    const targetStudent = studentsById.get(targetId);
    const selectedStudentName = s?.name || selectedId;
    const targetStudentName = targetStudent?.name || targetId;

    const isSettingKeepWith = type === 'pinKeepWith';
    const currentArray = s?.[type] || [];
    const isCurrentlySet = currentArray.includes(targetId);

    if (isCurrentlySet) {
      const newArray = currentArray.filter(id => id !== targetId);
      const reciprocalType = isSettingKeepWith ? 'pinKeepWith' : 'pinKeepApart';
      const targetArray = targetStudent?.[reciprocalType] || [];
      const newTargetArray = targetArray.filter(id => id !== selectedId);
      batchPatchStudents([
        { id: selectedId, patch: { [type]: newArray } },
        { id: targetId, patch: { [reciprocalType]: newTargetArray } }
      ]);
      return;
    }

    if (isSettingKeepWith && (targetStudent?.pinKeepApart || []).includes(selectedId)) {
      setBlockedMoveMessage(
        `Cannot set "${selectedStudentName} Keep With ${targetStudentName}". ${targetStudentName} is already set to be SEPARATED FROM ${selectedStudentName}.`
      );
      return;
    }
    if (!isSettingKeepWith && (targetStudent?.pinKeepWith || []).includes(selectedId)) {
      setBlockedMoveMessage(
        `Cannot set "${selectedStudentName} Separate From ${targetStudentName}". ${targetStudentName} is already set to be KEPT WITH ${selectedStudentName}.`
      );
      return;
    }

    const newArray = [...currentArray, targetId].filter(id => id !== selectedId);
    const reciprocalType = isSettingKeepWith ? 'pinKeepWith' : 'pinKeepApart';
    const targetArray = targetStudent?.[reciprocalType] || [];
    let newTargetArray = targetArray;
    if (!targetArray.includes(selectedId)) {
      newTargetArray = [...targetArray, selectedId];
    }
    batchPatchStudents([
      { id: selectedId, patch: { [type]: newArray } },
      { id: targetId, patch: { [reciprocalType]: newTargetArray } }
    ]);
  };

  const getButtonClass = (targetId, currentArray) => {
    const isActive = currentArray.includes(targetId);
    return `px-3 py-1.5 text-xs font-medium rounded-full border transition-all duration-200 truncate ${
      isActive
      ? 'bg-indigo-600 text-white border-indigo-600 shadow-md transform scale-105'
      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-indigo-300'
    }`;
  };

  const getClassName = (index) => {
    return classes[index]?.name || `Class ${index + 1}`;
  };

  const filteredStudents = sortedIds
  .filter(id => id !== selectedId)
  .filter(id => {
    const studentName = studentsById.get(id)?.name || '';
    return constraintSearch === '' || studentName.toLowerCase().includes(constraintSearch.toLowerCase());
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
    <div className="lg:col-span-4 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Student Focus</div>
    <select className="form-select block w-full border-slate-300 dark:border-slate-700 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-slate-800 dark:text-white py-2 px-3"
    value={selectedId||''}
    onChange={e=>setSelectedId(e.target.value||null)}>
    <option value="">(Select Student)</option>
    {sortedIds.map(id => <option key={id} value={id}>{studentsById.get(id)?.name}</option>)}
    </select>

    {s && (
      <div className="mt-4">
      <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Pin to Class</div>
      <select className="block w-full border-slate-300 dark:border-slate-700 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-slate-800 dark:text-white py-2 px-3"
      value={s?.pinClass ?? ''}
      onChange={e=>{
        const v = e.target.value==='' ? null : Number(e.target.value)
        patchStudent(selectedId, { pinClass: v })
      }}>
      <option value="">None (Auto-sort)</option>
      {Array.from({length:numClasses},(_,i)=>(
        <option key={i} value={i}>{getClassName(i)}</option>
      ))}
      </select>
      </div>
    )}
    </div>

    {['pinKeepWith', 'pinKeepApart'].map((type) => {
      if (!s) return null;
      const currentArray = s?.[type] || [];
      const isKeepWith = type === 'pinKeepWith';

      return (
        <div key={type} className="lg:col-span-4 flex flex-col h-full">
        <div className="flex items-center justify-between mb-2">
        <div className={`text-sm font-bold ${isKeepWith ? 'text-indigo-600 dark:text-indigo-400' : 'text-rose-600 dark:text-rose-400'}`}>
        {isKeepWith ? 'Keep With' : 'Separate From'}
        </div>
        <button className="text-xs font-medium text-slate-400 hover:text-rose-500 transition" onClick={()=>batchPatchStudents([{id:selectedId, patch:{[type]:[]}}])}>Clear All</button>
        </div>

        <input
        type="text"
        value={constraintSearch}
        onChange={(e) => setConstraintSearch(e.target.value)}
        placeholder="Search to add/remove..."
        className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg mb-3 bg-white dark:bg-slate-800 dark:text-white text-sm focus:ring-2 focus:ring-indigo-100 outline-none"
        />

        <div className="flex-1 border border-slate-200 dark:border-slate-700 rounded-xl p-3 max-h-64 overflow-y-auto flex flex-wrap content-start gap-2 bg-slate-50/50 dark:bg-slate-900/50">
        {/* Selected */}
        {currentArray.map(id => {
          const studentName = studentsById.get(id)?.name;
          return (
            <button
            key={id}
            onClick={() => togglePin(type, id)}
            className={getButtonClass(id, currentArray)}
            >
            <span className="mr-1">✓</span> {studentName}
            </button>
          );
        })}
        {/* Unselected */}
        {filteredStudents
          .filter(id => !currentArray.includes(id))
          .map(id => {
            const studentName = studentsById.get(id)?.name;
            return (
              <button
              key={id}
              onClick={() => togglePin(type, id)}
              className={getButtonClass(id, currentArray)}
              >
              + {studentName}
              </button>
            );
          })}
          {filteredStudents.length === 0 && constraintSearch && (
            <p className="text-slate-400 text-xs p-2">No results</p>
          )}
          </div>
          </div>
      );
    })}
    </div>
  );
}

/* ==========================================
 * PRINT SUMMARY COMPONENT
 * ========================================== */
function PrintOverview({ classes, studentsById, criteria, cv }) {
  if(!classes || !classes.length) return null
    const activeCriteria = criteria.filter(c => (c.weight??0) > 0 && c.enabled);

  return (
    <div className="hidden print:block mb-8 break-after-page">
    <div className="mb-6 border-b pb-4">
    <h1 className="text-3xl font-bold text-gray-900 mb-1">Class Placement Summary</h1>
    <p className="text-sm text-gray-500">Created with Class Balancer</p>
    </div>

    <table className="w-full text-sm border-collapse border border-gray-300">
    <thead>
    <tr className="bg-gray-100 text-left">
    <th className="border border-gray-300 p-2 font-bold text-gray-900">Class Name</th>
    <th className="border border-gray-300 p-2 font-bold text-gray-900 w-16 text-center">Size</th>
    <th className="border border-gray-300 p-2 font-bold text-gray-900 w-24 text-center">Gender</th>
    {/* HIDE OVERALL SCORE IF ALL CRITERIA HIDDEN */}
    {activeCriteria.length > 0 && (
      <th className="border border-gray-300 p-2 font-bold text-gray-900 w-24 text-right">Avg Score</th>
    )}
    {activeCriteria.map(c => (
      <th key={c.label} className="border border-gray-300 p-2 font-bold text-gray-900 text-right">
      {c.label} (Avg)
      </th>
    ))}
    </tr>
    </thead>
    <tbody>
    {classes.map((c, i) => {
      const ids = c.studentIds;
      const relevantIds = ids.filter(id => !studentsById.get(id)?.ignoreScores);
      let M=0, F=0;
      ids.forEach(id => {
        const g = studentsById.get(id)?.gender;
        if(g==='M') M++;
        else if(g==='F') F++;
      });
        const sumComp = relevantIds.reduce((acc,id)=> acc + getCompositeScore(studentsById,id,criteria,cv), 0);
        const avgComp = relevantIds.length ? (sumComp/relevantIds.length).toFixed(1) : '-';

        return (
          <tr key={c.id} className="even:bg-gray-50">
          <td className="border border-gray-300 p-2 font-semibold">{c.name || `Class ${i+1}`}</td>
          <td className="border border-gray-300 p-2 text-center">{ids.length}</td>
          <td className="border border-gray-300 p-2 text-center text-xs">{M}M / {F}F</td>

          {/* HIDE OVERALL SCORE IF ALL CRITERIA HIDDEN */}
          {activeCriteria.length > 0 && (
            <td className="border border-gray-300 p-2 text-right font-mono">{avgComp}</td>
          )}

          {activeCriteria.map(crit => {
            const sum = relevantIds.reduce((acc,id) => acc + (Number(studentsById.get(id)?.criteria?.[crit.label])||0), 0);
            const avg = relevantIds.length ? (sum/relevantIds.length).toFixed(1) : '-';
          return <td key={crit.label} className="border border-gray-300 p-2 text-right font-mono text-gray-600">{avg}</td>
          })}
          </tr>
        )
    })}
    </tbody>
    </table>
    </div>
  )
}


/* ==========================================
 * MAIN APP COMPONENT
 * ========================================== */
export default function App(){
  const [dark, setDark] = useState(false)
  useEffect(()=>{ document.documentElement.classList.toggle('dark', dark) }, [dark])

  const [studentsById, setStudentsById] = useState(new Map())
  const [allIds, setAllIds] = useState([])
  const [criteria, setCriteria] = useState([])
  const [classMeta, setClassMeta] = useState([])
  const [classes, setClasses] = useState([])
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('overallHigh')
  const [numClasses, setNumClasses] = useState(6)
  const [newCritName, setNewCritName] = useState('');
  const [hasManualChanges, setHasManualChanges] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [blockedMoveMessage, setBlockedMoveMessage] = useState(null);
  const [mode, setMode] = useState('balanced')
  const [levelOn, setLevelOn] = useState('Reading')
  const criteriaVersion = useMemo(()=> makeCriteriaVersion(criteria), [criteria])

  // Drag and Drop
  const dragRef = useRef(null)
  function onDragStartStudent(e, sid, fromIdx){
    dragRef.current = { sid, fromIdx }
    e.dataTransfer.effectAllowed = 'move'
  }
  function handleDrop(toIdx, e){
    e.preventDefault()
    const info = dragRef.current
    if(!info || info.fromIdx === toIdx) return

      const sid = info.sid
      const destIds = classes[toIdx]?.studentIds || []
      const sidSep = new Set((studentsById.get(sid)?.pinKeepApart||[]))
      for(const x of destIds){
        const xSep = new Set((studentsById.get(x)?.pinKeepApart||[]))
        if(sidSep.has(x) || xSep.has(sid)){
          const blockingStudent = studentsById.get(x)?.name || 'another student';
          setBlockedMoveMessage(`Cannot move ${studentsById.get(sid)?.name} into this class. A separation constraint exists with ${blockingStudent}.`);
          dragRef.current = null;
          return;
        }
      }

      setClasses(prev=>{
        const copy = prev.map(c => ({ ...c, studentIds:[...c.studentIds] }))
        const src = copy[info.fromIdx]
        const dst = copy[toIdx]
        const i = src.studentIds.indexOf(info.sid)
        if(i > -1){
          src.studentIds.splice(i,1)
          if (!dst.studentIds.includes(info.sid)) {
            dst.studentIds.push(info.sid)
          }
        }
        return copy
      })
      setStudentsById(prev=>{
        const m = new Map(prev)
        const s = { ...m.get(sid), pinClass: toIdx }
        m.set(sid, s)
        return m
      })
      dragRef.current = null
      setHasManualChanges(true);
  }

  useEffect(() => { scoreCache.clear(); metersCache.clear() }, [studentsById, criteria])

  function updateStudent(id, patch){
    setStudentsById(prev => {
      const s = prev.get(id);
      const newStudent = { ...s, ...patch };
      if (patch.firstName !== undefined || patch.lastName !== undefined || patch.name !== undefined) {
        let fn = patch.firstName !== undefined ? patch.firstName : (s.firstName || '');
        let ln = patch.lastName !== undefined ? patch.lastName : (s.lastName || '');
        if (patch.name !== undefined) {
          const parts = patch.name.trim().split(/\s+/);
          fn = parts.shift() || '';
          ln = parts.join(' ') || '';
        }
        newStudent.firstName = fn;
        newStudent.lastName = ln;
        newStudent.name = `${fn} ${ln}`.trim();
      }
      setHasManualChanges(true);
      const copy=new Map(prev);
      copy.set(id, newStudent);
      return copy;
    });
  }
  function deleteStudent(id){
    setStudentsById(prev => { const copy=new Map(prev); copy.delete(id); return copy })
    setAllIds(prev => prev.filter(x=>x!==id))
    setClasses(prev=> prev.map(c=>({ ...c, studentIds: c.studentIds.filter(x=>x!==id) })))
  }

  const [lastAddedId, setLastAddedId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [draftStudent, setDraftStudent] = useState(null)
  const [statusMessage, setStatusMessage] = useState({ message: '', type: 'success' });

  const displayStatus = (message, type = 'success', duration = 4000) => {
    setStatusMessage({ message, type });
    setTimeout(() => setStatusMessage({ message: '', type: 'success' }), duration);
  };

  function openAddStudent(){
    const activeCriteria = criteria.filter(c => (c.weight ?? 0) > 0);
    const crit = {}; activeCriteria.forEach(c=>{ crit[c.label]=0 })
    setDraftStudent({
      firstName: '', lastName: '', name:'', id:'', gender:'', previousTeacher:'', notes:'', tags:'', criteria:crit
    })
    setShowAdd(true)
  }
  function submitAddStudent(){
    if(!draftStudent) return
      let firstName = (draftStudent.firstName||'').trim();
    let lastName = (draftStudent.lastName||'').trim();
    if (!firstName && !lastName) {
      const nameParts = (draftStudent.name || '').trim().split(/\s+/);
      firstName = nameParts.shift() || '';
      lastName = nameParts.join(' ') || '';
    }
    const fullName = `${firstName} ${lastName}`.trim();
    if(!fullName){
      displayStatus('Please enter a name for the student.', 'error');
      return
    }
    const baseRaw = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let newId = baseRaw;
    let n=1;
    while(studentsById.has(newId) || newId === '') {
      newId = baseRaw + (++n);
    }
    const tags = (draftStudent.tags||'').split(/[|,;/]/).map(t=>t.trim()).filter(Boolean)
    const student = {
      id:newId, firstName, lastName, name: fullName,
      gender: draftStudent.gender || undefined,
      previousTeacher: draftStudent.previousTeacher || '',
      notes: draftStudent.notes || '',
      tags,
      criteria: { ...(draftStudent.criteria||{}) },
      pinClass: null, pinKeepWith: [], pinKeepApart: []
    }
    setStudentsById(prev => {
      const m=new Map(prev); m.set(student.id, student)
      const cv = makeCriteriaVersion(criteria)
      const destIdx = (mode==='leveled')
      ? pickClassForNewStudentLeveled(student.id, classes, m, criteria, cv, levelOn)
      : pickClassForNewStudentBalanced(student.id, classes, m, criteria, cv)
      setClasses(prevC => {
        const copy = prevC.map(c => ({...c, studentIds:[...c.studentIds]}))
        if(copy[destIdx] && !copy[destIdx].studentIds.includes(student.id)){
          copy[destIdx].studentIds.push(student.id)
        }
        const label = copy[destIdx]?.name || `Class ${destIdx+1}`
        displayStatus(`Added ${student.name} to ${label}`, 'success');
        setLastAddedId(student.id)
        setTimeout(()=>setLastAddedId(null), 2000)
        return copy
      })
      return m
    })
    setAllIds(prev => [...prev, student.id])
    setShowAdd(false)
    setDraftStudent(null)
  }

  function runAutoPlace(){
    const keepTogetherPairs = []
    allIds.forEach(id => (studentsById.get(id)?.pinKeepWith||[]).forEach(o=>keepTogetherPairs.push([id,o])))
    const keepApartPairs = []
    allIds.forEach(id => (studentsById.get(id)?.pinKeepApart||[]).forEach(o=>keepApartPairs.push([id,o])))

    const opts = { criteria, keepTogetherPairs, keepApartPairs, classMeta }
    if (mode === 'leveled') {
      const out = leveledPlace(studentsById, allIds, numClasses, { ...opts, levelOn })
      setClasses(out.classes)
    } else {
      const out = autoPlace(studentsById, allIds, numClasses, opts)
      setClasses(out.classes)
    }
    setHasManualChanges(false);
  }

  useEffect(()=>{
    if (allIds.length > 0 && classes.length === 0) {
      runAutoPlace();
    }
  }, [studentsById, allIds.length, numClasses, criteria, mode, levelOn]);

  const handleRunBalancingClick = () => {
    if (hasManualChanges) {
      setShowConfirmModal(true);
    } else {
      runAutoPlace();
    }
  };
  const handleConfirmRun = () => {
    setShowConfirmModal(false);
    runAutoPlace();
  };

  const getGenderClass = (gender) => {
    const base = "text-[10px] w-5 h-5 flex items-center justify-center rounded-full shrink-0 font-bold border"
    if (gender === 'F') return `${base} bg-pink-100 text-pink-700 border-pink-200`;
    if (gender === 'M') return `${base} bg-blue-100 text-blue-700 border-blue-200`;
    return `${base} bg-slate-100 text-slate-500 border-slate-200`;
  };

  function Field({ label, children }) {
    return (
      <div className="flex flex-col gap-1.5 min-w-[140px]">
      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</div>
      {children}
      </div>
    );
  }

  /* ---------- I/O (CSV/JSON) ---------- */
  function exportCSV(){
    const studentClassMap = new Map();
    classes.forEach(cls => { cls.studentIds.forEach(id => { studentClassMap.set(id, cls.name); }); });
    const headers = ['Class Name', 'First Name','Last Name','gender','tags','notes','Previous Teacher', ...criteria.map(c=>c.label)]
    const rows = allIds.map(id => {
      const s = studentsById.get(id)
      const className = studentClassMap.get(id) || 'Unassigned';
    const base = [ className, s.firstName || '', s.lastName || '', s.gender||'', (s.tags||[]).join('; '), (s.notes||'').replaceAll('\n',' '), s.previousTeacher||'' ]
    const crit = criteria.map(c => Number(s.criteria?.[c.label]) || 0)
    return base.concat(crit)
    })
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const csv = [headers.join(','), ...rows.map(r=>r.join(','))].join('\n')
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'balanced-class-roster.csv'; a.click(); URL.revokeObjectURL(url)
  }
  async function importCSV(file){
    try {
      const {students, criteriaLabels, maxScores} = safeParseCSV(await file.text())
      if(!students.length) throw new Error('No rows detected.')
        let critMerged=[]
        criteriaLabels.forEach(label => {
          const max = maxScores[label] || 100;
          critMerged.push({ label, weight:1.0, max: max, enabled: true });
        })
        const map=new Map(); const ids=[];
      students.forEach(st => {
        let currentId = st.id;
        let n = 1;
        const baseNameId = `${st.firstName}${st.lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
        while(map.has(currentId)) { currentId = baseNameId + (++n); }
        const merged={...(st.criteria||{})}
        critMerged.forEach(c => { if(merged[c.label]===undefined || Number.isNaN(merged[c.label])) merged[c.label]=0 })
        const pinReady = { pinClass: st.pinClass ?? null, pinKeepWith: st.pinKeepWith ?? [], pinKeepApart: st.pinKeepApart ?? [] }
        const cleanSt = { ...st, ignoreScores: st.ignoreScores ?? false }; delete cleanSt.enabled;
        map.set(currentId, {...cleanSt, ...pinReady, criteria:merged, id: currentId});
        ids.push(currentId);
      })
      setCriteria(critMerged); setStudentsById(map); setAllIds(ids); setClassMeta([])
      setClasses([]);
      displayStatus(`Imported ${ids.length} students and ${criteriaLabels.length} factors.`, 'success');
      setHasManualChanges(false);
    } catch (err) { displayStatus('Load failed: '+(err?.message||err), 'error', 6000); }
  }
  function exportJSON(){
    const payload = { version: 'bcs-1', numClasses, criteria: criteria.map(({ enabled, ...rest }) => rest), students: Array.from(studentsById.values()), classMeta, classes, }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'bcs-session.json'; a.click(); URL.revokeObjectURL(url)
  }
  async function importJSON(file){
    try {
      const text = await file.text()
      let data
      try{ data = JSON.parse(text) } catch(e){ throw new Error('Invalid JSON') }
      if(!data || !Array.isArray(data.students)) throw new Error('Missing students')
        const map = new Map(); const ids = []
        for(const s of data.students){
          if(!s || !s.id) continue
            let fn = s.firstName || ''; let ln = s.lastName || '';
          if (!fn && !ln && s.name) { const parts = s.name.split(/\s+/); fn = parts.shift() || ''; ln = parts.join(' ') || ''; }
          const newStudent = { pinClass:null, pinKeepWith:[], pinKeepApart:[], ignoreScores: false, ...s, firstName: fn, lastName: ln, name: `${fn} ${ln}`.trim() };
          map.set(s.id, newStudent); ids.push(s.id);
        }
        setStudentsById(map); setAllIds(ids)
        if(Array.isArray(data.criteria)) {
          const processedCriteria = data.criteria.map(c => {
            if (c.enabled === undefined) c.enabled = (c.weight ?? 0) > 0;
            return c;
          });
          setCriteria(processedCriteria);
        }
        if(data.numClasses > 0) setNumClasses(data.numClasses)
          if(Array.isArray(data.classMeta)) setClassMeta(data.classMeta)
            if(Array.isArray(data.classes)) setClasses(data.classes)
              displayStatus(`Loaded ${ids.length} students from Session.`, 'success');
      setHasManualChanges(false);
    } catch(err) { displayStatus('Load failed: '+(err?.message||err), 'error', 6000); }
  }

  const handleWeightChange = (label, newWeightLabel) => {
    const newWeight = WEIGHT_MAP[newWeightLabel];
    if (newWeight === undefined) return;
    setCriteria(prev => prev.map(c => c.label === label ? { ...c, weight: newWeight } : c));
    setHasManualChanges(true);
  };
  const handleShowToggle = (label) => {
    setCriteria(prev => prev.map(c => c.label === label ? { ...c, enabled: !c.enabled } : c));
  };

  // Styles
  const printStyles = `
  @media print {
    /* FORCE WHITE BACKGROUND / BLACK TEXT TO SAVE INK & FIX DARK MODE BUG */
    :root, body, #root, .min-h-screen {
      background-color: white !important;
      color: black !important;
      min-height: 0 !important;
      height: auto !important;
      overflow: visible !important;
    }
    /* Explicitly override dark mode classes that might linger */
    .dark\\:bg-slate-900, .dark\\:bg-slate-950, .dark\\:text-white, .dark\\:text-slate-200 {
      background-color: white !important;
      color: black !important;
    }

    @page { margin: 0.5cm; size: auto; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
    .print-break-after { break-after: page; page-break-after: always; }
    .print-full-width { width: 100% !important; max-width: none !important; }
    .print-reset-grid { display: block !important; }
    .print-clean { box-shadow: none !important; border: none !important; margin: 0 !important; padding: 0 !important; background: transparent !important; }
    .screen-only-content { display: none !important; }
    .print-only-content { display: block !important; }

    /* FIX: Kill extra page by hiding empty trailing space */
    body > *:last-child { margin-bottom: 0 !important; padding-bottom: 0 !important; }

    /* FIX: Force table to respect column widths */
    table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
    th, td { border: 1px solid #ccc; padding: 2px 4px; text-align: left; vertical-align: top; word-wrap: break-word; overflow: hidden; }
    th { background-color: #f3f4f6 !important; font-weight: bold; }
    .class-roster-container { margin-top: 20px; margin-bottom: 20px; }
  }
  .print-only-content { display: none; }
  `;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-sans selection:bg-indigo-100 selection:text-indigo-700 print:bg-white print:text-black">
    <style>{printStyles}</style>

    {/* CONFIRM MODAL */}
    <Modal
    open={showConfirmModal}
    onClose={() => setShowConfirmModal(false)}
    title="Confirm Re-Balancing"
    >
    <div className="text-slate-600 dark:text-slate-300">
    <p className="mb-4">You have made manual changes to the class rosters since the last automated run.</p>
    <p className="font-bold text-rose-600">
    Running the algorithm will overwrite all manual drag-and-drop assignments.
    </p>
    <p className="mt-2 text-sm">
    (Manual pins set in the "Manual Pins" section will be respected.)
    </p>
    </div>
    <div className="flex justify-end gap-3 mt-6">
    <button
    onClick={() => setShowConfirmModal(false)}
    className="px-4 py-2 rounded-lg border border-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
    >
    Cancel
    </button>
    <button
    onClick={handleConfirmRun}
    className="px-4 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 shadow-lg shadow-rose-500/30 transition"
    >
    Yes, Run and Overwrite
    </button>
    </div>
    </Modal>

    {/* BLOCKED MODAL */}
    <Modal
    open={!!blockedMoveMessage}
    onClose={() => setBlockedMoveMessage(null)}
    title="Constraint Violation"
    >
    <div className="text-slate-600 dark:text-slate-300">
    <p className="font-bold text-rose-600 mb-4 flex items-center gap-2">
    <span className="text-2xl">⚠️</span> Constraint Error
    </p>
    <p>{blockedMoveMessage}</p>
    <p className="mt-4 text-sm bg-slate-100 dark:bg-slate-800 p-3 rounded-lg">Please remove the conflicting constraint in the "Manual Pins & Relationships" section before proceeding.</p>
    </div>
    <div className="flex justify-end mt-6">
    <button
    onClick={() => setBlockedMoveMessage(null)}
    className="px-4 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-700"
    >
    Acknowledge
    </button>
    </div>
    </Modal>

    {/* --- TOOLBAR --- */}
    <div className="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm no-print transition-all">
    <div className="max-w-9xl mx-auto px-6 py-4 space-y-4">
    {/* Top Row */}
    <div className="flex items-center justify-between gap-4">
    <div className="flex items-center gap-3">
    <div className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
    Class<span className="text-indigo-600 dark:text-indigo-400">Balancer</span>
    </div>
    <span className="text-xs px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-500 font-mono">
    {VERSION}
    </span>
    <button onClick={()=>setDark(d=>!d)} className="p-2 hover:bg-slate-100 rounded-full transition text-slate-500">
    {dark ? '🌙' : '☀️'}
    </button>
    </div>

    <div className="flex flex-wrap items-center gap-2">
    {/* File Ops */}
    <div className="flex items-center gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
    <button
    onClick={()=>document.getElementById('csvInput')?.click()}
    className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300"
    >
    Import Roster
    </button>
    <input id="csvInput" type="file" accept=".csv,text/csv" className="hidden" onChange={(e)=>{ const f=e.target.files?.[0]; if(!f) return; importCSV(f).finally(()=>{ e.target.value='' }) }}/>

    <button onClick={exportCSV} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">
    Export Roster
    </button>
    <div className="w-px h-4 bg-slate-300 mx-1"></div>
    <button
    onClick={()=>document.getElementById('jsonInput')?.click()}
    className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300"
    >
    Load Session
    </button>
    <input id="jsonInput" type="file" accept="application/json,.json" className="hidden" onChange={(e)=>{ const f=e.target.files?.[0]; if(!f) return; importJSON(f).finally(()=>{ e.target.value='' }) }}/>
    <button onClick={exportJSON} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">
    Save Session
    </button>
    </div>
    <button onClick={()=>window.print()} className="ml-2 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-900 hover:shadow-lg transition">
    Print / PDF
    </button>
    </div>
    </div>

    {/* Controls Row */}
    <div className="flex flex-col lg:flex-row items-end lg:items-center gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full lg:w-auto flex-1">
    <Field label="Classes">
    <input
    type="number"
    min={1}
    max={20}
    value={numClasses}
    onChange={e=>setNumClasses(parseInt(e.target.value||'1',10))}
    className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium"
    />
    </Field>

    <Field label="Sort Lists By">
    <select
    className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium"
    value={sortMode}
    onChange={e=>setSortMode(e.target.value)}
    >
    <option value="overallHigh">High to Low</option>
    <option value="overallLow">Low to High</option>
    <option value="lastName">Last Name (A-Z)</option>
    <option value="firstName">First Name (A-Z)</option>
    </select>
    </Field>

    <Field label="Algorithm Mode">
    <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg w-full">
    {['balanced', 'leveled'].map((m) => (
      <button
      key={m}
      onClick={() => setMode(m)}
      className={`flex-1 px-3 py-1.5 rounded-md text-sm font-bold capitalize transition-all ${
        mode === m
        ? 'bg-white dark:bg-slate-600 text-indigo-600 dark:text-indigo-200 shadow-sm'
        : 'text-slate-500 hover:text-slate-700'
      }`}
      >
      {m}
      </button>
    ))}
    </div>
    </Field>

    {mode === 'leveled' ? (
      <Field label="Level on">
      <select
      className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium"
      value={levelOn}
      onChange={e=>setLevelOn(e.target.value)}
      >
      <option value="Composite">Overall Score</option>
      {criteria.map(c => (
        <option key={c.label} value={c.label}>{c.label}</option>
      ))}
      </select>
      </Field>
    ) : <div/>}
    </div>

    {/* Action Button */}
    <button
    onClick={handleRunBalancingClick}
    className={`w-full lg:w-auto px-8 py-3 rounded-xl text-white text-sm font-bold tracking-wide shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.02] active:scale-95 transition-all duration-200 ease-out
      ${hasManualChanges
        ? 'bg-gradient-to-r from-rose-500 to-orange-600 ring-2 ring-rose-200 animate-pulse'
        : 'bg-gradient-to-r from-indigo-600 to-blue-600'
      }`}
      >
      {hasManualChanges ? 'Run Re-Balance (!)' : 'Run Class Balancing'}
      </button>
      </div>
      </div>
      </div>

      {/* STATUS TOAST */}
      {statusMessage.message && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300 no-print">
        <div className={`rounded-xl border px-4 py-3 shadow-xl font-medium flex items-center gap-3
          ${statusMessage.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' :
            statusMessage.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' :
            'border-amber-200 bg-amber-50 text-amber-700'}`}
            >
            <span>{statusMessage.type === 'error' ? '✕' : '✓'}</span>
            {statusMessage.message}
            </div>
            </div>
      )}

      {/* MAIN CONTENT AREA */}
      <div className="max-w-9xl mx-auto px-6 py-8 space-y-8">

      {/* CRITERIA PANEL */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
      <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-bold text-slate-800 dark:text-white">Balancing Factors</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {criteria.map(c => (
        <div key={c.label} className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 transition-colors">
        <div className="flex items-center justify-between mb-3">
        <div className="font-bold text-slate-700 dark:text-slate-200 truncate pr-2" title={c.label}>{c.label}</div>
        <div className="flex items-center gap-2">
        <label className="text-[10px] flex items-center gap-1 text-slate-500 cursor-pointer select-none">
        <input type="checkbox" checked={c.enabled} onChange={()=>handleShowToggle(c.label)} className="rounded text-indigo-600 focus:ring-indigo-500"/>
        Show
        </label>
        <button className="text-slate-400 hover:text-rose-500 transition" onClick={()=>setCriteria(prev=>prev.filter(x=>x.label!==c.label))}>×</button>
        </div>
        </div>

        <div className="space-y-2">
        <div>
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Importance</div>
        <div className="flex bg-white dark:bg-slate-700 rounded-lg p-0.5 border border-slate-200 dark:border-slate-600">
        {['Low', 'Normal', 'High'].map(label => {
          const isActive = c.weight === WEIGHT_MAP[label];
          return (
            <button
            key={label}
            className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all ${
              isActive
              ? 'bg-indigo-100 text-indigo-700 shadow-sm'
              : 'text-slate-400 hover:text-slate-600'
            }`}
            onClick={() => handleWeightChange(c.label, label)}
            >
            {label}
            </button>
          );
        })}
        </div>
        </div>
        <div>
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Max Score</div>
        <input type="number" value={c.max}
        onChange={e=>setCriteria(prev=>prev.map(x=>x.label===c.label?{...x,max:parseFloat(e.target.value||'100')}:x))}
        className="w-full text-xs font-mono border-slate-200 rounded px-2 py-1 bg-white dark:bg-slate-900 dark:text-white focus:border-indigo-500 outline-none" />
        </div>
        </div>
        </div>
      ))}

      {/* Add New */}
      <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-3 flex flex-col justify-center gap-2 bg-slate-50/50 dark:bg-slate-800/50">
      <input
      value={newCritName}
      onChange={(e)=>setNewCritName(e.target.value)}
      placeholder="New factor name..."
      className="border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 text-sm w-full bg-white dark:bg-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
      />
      <button
      onClick={()=>{
        const label = (newCritName||'').trim()
        if(!label || criteria.some(c=>c.label===label)) return
          setCriteria(prev => [...prev, { label, weight:1.0, max:100, enabled: true }])
          setStudentsById(prev => {
            const c=new Map(prev)
            c.forEach(v => { v.criteria = { ...(v.criteria||{}), [label]: 0 } })
            return c
          })
          setNewCritName('')
      }}
      className="w-full py-1.5 rounded bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition"
      >
      + Add Factor
      </button>
      </div>
      </div>
      </div>

      {/* PRINT TABLE */}
      <PrintOverview classes={classes} studentsById={studentsById} criteria={criteria} cv={criteriaVersion} />

      {/* CLASS GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-6 print-reset-grid">
      {(() => {
        const cls = classes.map((c, idx)=> ({...c, name: classMeta[idx]?.name || c.name, studentIds:[...c.studentIds]}))
        cls.forEach(c => {
          if(sortMode==='overallHigh'){
            c.studentIds.sort((a,b)=> getCompositeScore(studentsById,b,criteria,criteriaVersion) - getCompositeScore(studentsById,a,criteria,criteriaVersion))
          } else if (sortMode === 'overallLow') {
            c.studentIds.sort((a,b)=> getCompositeScore(studentsById,a,criteria,criteriaVersion) - getCompositeScore(studentsById,b,criteria,criteriaVersion));
          } else if (sortMode === 'lastName') {
            c.studentIds.sort((a, b) => (studentsById.get(a)?.lastName || '').localeCompare(studentsById.get(b)?.lastName || ''));
          } else if (sortMode === 'firstName') {
            c.studentIds.sort((a, b) => (studentsById.get(a)?.firstName || '').localeCompare(studentsById.get(b)?.firstName || ''));
          }
        })
        const currentAllIds = allIds;

        return cls.map((c, idx) => {
          const s = stats(studentsById, c.studentIds)
          const meters = calcMeters(c, studentsById, criteria, currentAllIds, criteriaVersion)
          return (
            <div
            key={c.id}
            className="flex flex-col h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/50 dark:bg-slate-900/50 backdrop-blur-sm print-break-after print-clean print-full-width"
            >
            {/* Header */}
            <div className="p-4 bg-white dark:bg-slate-900 rounded-t-2xl border-b border-slate-100 dark:border-slate-800">
            <input
            className="font-bold text-lg text-slate-800 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none w-full transition-colors"
            value={classMeta[idx]?.name ?? c.name}
            onChange={e=>{
              const v=e.target.value
              setClassMeta(prev=>{ const copy=[...prev]; copy[idx]={ ...(copy[idx]||{}), name:v }; return copy })
              setClasses(prev=> prev.map((x,i)=> i===idx ? ({...x, name:v}) : x ))
            }}
            />
            <div className="flex items-center gap-3 mt-2 text-xs font-medium text-slate-500">
            <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-600 dark:text-slate-400 print:!bg-transparent print:!text-black print:!border print:!border-slate-300">Size: {s.size}</span>
            {/* Updated M/F Indicators with Text Labels for Print Safety */}
            <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-400 print:bg-blue-400" style={{printColorAdjust: 'exact'}}></span>
            <span className="text-slate-500 dark:text-slate-400 print:!text-black">M {s.M}</span>
            </span>
            <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-pink-400 print:bg-pink-400" style={{printColorAdjust: 'exact'}}></span>
            <span className="text-slate-500 dark:text-slate-400 print:!text-black">F {s.F}</span>
            </span>
            </div>

            {/* Meters */}
            <div className="mt-4 space-y-2 no-print">
            {meters.map(m => (
              <div key={m.label} title={`Class Avg: ${m.avg.toFixed(2)}`}>
              <div className="flex justify-between text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-wide">
              <span>{m.label}</span>
              <span className={m.colorClass.replace('bg-','text-')}>{m.labelText}</span>
              </div>
              <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
              <div className={`h-full rounded-full transition-all duration-500 ease-out ${m.colorClass}`} style={{ width: m.pct+'%' }} />
              </div>
              </div>
            ))}
            </div>
            </div>

            {/* Body (Drop Zone) */}
            <div className="p-3 flex-1 overflow-y-auto min-h-[300px]">
            <ul
            className="space-y-2 screen-only-content h-full"
            onDragOver={(e)=>e.preventDefault()}
            onDrop={(e)=>handleDrop(idx, e)}
            >
            {c.studentIds.map(id => {
              const st = studentsById.get(id);
              if (!st) return null
                const overall = getCompositeScore(studentsById, id, criteria, criteriaVersion)
                const bits = criteria.filter(cc => (cc.weight ?? 0) > 0 && cc.enabled).map(cc => `${cc.label.charAt(0)}:${st.criteria?.[cc.label] ?? 0}`)

                return (
                  <li
                  key={id}
                  draggable
                  onDragStart={(e) => onDragStartStudent(e, id, idx)}
                  className={
                    "group relative p-3 rounded-xl border border-transparent bg-white dark:bg-slate-800 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-grab active:cursor-grabbing border-l-4 " +
                    (st.gender === 'F' ? "border-l-pink-400 " : st.gender === 'M' ? "border-l-blue-400 " : "border-l-slate-300 ") +
                    (id === lastAddedId ? "ring-2 ring-emerald-500 ring-offset-2" : "")
                  }
                  >
                  <div className="flex items-start justify-between gap-2">
                  <div>
                  <div className="font-bold text-sm text-slate-800 dark:text-slate-100 leading-tight">{st.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 font-medium">
                  <span className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  {Math.round(overall)}
                  </span>
                  <span className="opacity-80 text-[10px]">{bits.join(' · ')}</span>
                  </div>
                  </div>
                  </div>

                  {(st.notes || st.previousTeacher) && (
                    <div className="mt-2 pt-2 border-t border-slate-50 dark:border-slate-700 space-y-0.5">
                    {st.previousTeacher && <div className="text-[10px] text-slate-400">Prev: {st.previousTeacher}</div>}
                    {st.notes && <div className="text-[10px] text-slate-400 italic line-clamp-2">{st.notes}</div>}
                    </div>
                  )}

                  {Array.isArray(st.tags) && st.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                    {st.tags.map(tag => (
                      <span key={tag} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 text-slate-500 uppercase tracking-wide">
                      {tag}
                      </span>
                    ))}
                    </div>
                  )}
                  </li>
                )
            })}
            </ul>

            {/* Print View Table Logic (Hidden on screen) */}
            <div className="print-only-content class-roster-container">
            <table className="w-full text-xs border-collapse">
            <thead>
            <tr className="border-b border-gray-400 text-left">
            {/* Adjusted Widths to fit data */}
            <th className="py-1 w-[18%]">Name</th>
            <th className="py-1 w-[5%] text-center">Gen</th>
            <th className="py-1 w-[10%]">Tags</th>

            {/* HIDE OVERALL SCORE IF ALL CRITERIA HIDDEN */}
            {criteria.filter(crit => (crit.weight??0) > 0 && crit.enabled).length > 0 && (
              <th className="py-1 w-[7%] text-right">Score</th>
            )}

            {criteria.filter(crit => (crit.weight??0) > 0 && crit.enabled).map(crit => <th key={crit.label} className="py-1 w-[5%] text-right text-[9px]">{crit.label.substring(0,3)}</th>)}
            <th className="py-1 w-[10%] pl-2">Previous</th>
            <th className="py-1 w-auto pl-2">Notes</th>
            </tr>
            </thead>
            <tbody>
            {c.studentIds.map(id => {
              const st = studentsById.get(id);
              if(!st) return null;

              // Check if any criteria are enabled
              const hasEnabledCriteria = criteria.filter(crit => (crit.weight??0) > 0 && crit.enabled).length > 0;

              return (
                <tr key={id} className="border-b border-gray-100">
                <td className="py-1 truncate">{st.lastName}, {st.firstName}</td>
                <td className="py-1 text-center">{st.gender}</td>
                <td className="py-1 text-[9px] text-gray-500 leading-tight">{(st.tags || []).join(', ')}</td>

                {/* HIDE OVERALL SCORE IF ALL CRITERIA HIDDEN */}
                {hasEnabledCriteria && (
                  <td className="py-1 text-right">{Math.round(getCompositeScore(studentsById, id, criteria, criteriaVersion))}</td>
                )}

                {criteria.filter(crit => (crit.weight??0) > 0 && crit.enabled).map(crit => <td key={crit.label} className="py-1 text-right text-gray-500">{st.criteria?.[crit.label] ?? 0}</td>)}
                <td className="py-1 text-gray-700 text-[9px] pl-2 truncate">{st.previousTeacher}</td>
                <td className="py-1 text-gray-700 text-[9px] pl-2 italic leading-tight">{st.notes}</td>
                </tr>
              )
            })}
            </tbody>
            </table>
            </div>
            </div>
            </div>
          )
        })
      })()}
      </div>

      {/* MANUAL PINS */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
      <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4">Manual Pins & Relationships</h2>
      <ManualPins allIds={allIds} studentsById={studentsById} numClasses={numClasses} setStudentsById={setStudentsById} classes={classes} setBlockedMoveMessage={setBlockedMoveMessage} />
      </div>

      {/* EDIT STUDENTS */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
      <h2 className="text-lg font-bold text-slate-800 dark:text-white">Student Roster</h2>
      <div className="flex items-center gap-2">
      <input
      placeholder="Search roster..."
      className="border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none w-64"
      value={search}
      onChange={e=>setSearch(e.target.value)}
      />
      <button onClick={openAddStudent} className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition shadow-lg shadow-emerald-500/20">
      + New Student
      </button>
      </div>
      </div>

      <div className="overflow-y-auto max-h-[500px] pr-2 space-y-2">
      {[...allIds]
        .filter(id => (studentsById.get(id)?.name + id).toLowerCase().includes(search.toLowerCase()))
        .sort((a,b)=> (studentsById.get(a)?.lastName||'').localeCompare(studentsById.get(b)?.lastName||''))
        .map(id=>{
          const s = studentsById.get(id)
          return (
            <div key={id} className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-sm bg-white dark:bg-slate-800 hover:border-indigo-300 transition">
            <div className="flex items-center justify-between mb-3">
            <div className="font-bold text-slate-800 dark:text-white text-base">{s.name}</div>
            <button className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50" onClick={()=>deleteStudent(s.id)}>Delete</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
            <div className="space-y-1">
            <div className="text-[10px] uppercase text-slate-400 font-bold">First Name</div>
            <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.firstName || ''} onChange={e=>updateStudent(s.id,{ firstName: e.target.value })} />
            </div>
            <div className="space-y-1">
            <div className="text-[10px] uppercase text-slate-400 font-bold">Last Name</div>
            <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.lastName || ''} onChange={e=>updateStudent(s.id,{ lastName: e.target.value })} />
            </div>
            <div className="space-y-1">
            <div className="text-[10px] uppercase text-slate-400 font-bold">Gender</div>
            <select className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.gender || ''} onChange={e=>updateStudent(s.id,{ gender:e.target.value||undefined })}>
            <option value="">—</option><option value="M">Male</option><option value="F">Female</option>
            </select>
            </div>
            <div className="space-y-1">
            <div className="text-[10px] uppercase text-slate-400 font-bold">Prev Teacher</div>
            <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.previousTeacher||''} onChange={e=>updateStudent(s.id,{ previousTeacher: e.target.value })} />
            </div>
            </div>

            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase text-slate-400 font-bold">Scores</div>
            {/* RESTORED: Ignore Scores Checkbox */}
            <label className="flex items-center gap-1.5 cursor-pointer">
            <input
            type="checkbox"
            checked={s.ignoreScores || false}
            onChange={e => updateStudent(s.id, { ignoreScores: e.target.checked })}
            className="w-3.5 h-3.5 rounded text-amber-500 focus:ring-amber-500 border-gray-300"
            />
            <span className="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-wide">Exclude from Balancing</span>
            </label>
            </div>

            <div className="flex flex-wrap gap-3">
            {criteria.map(c => (
              <div key={c.label} className="flex flex-col">
              <span className="text-[10px] text-slate-500 truncate max-w-[80px] text-center">{c.label}</span>
              <input type="number" className="w-20 border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-center bg-white dark:bg-slate-800 dark:text-white focus:ring-1 focus:ring-indigo-500"
              value={(s.criteria?.[c.label] ?? '')}
              onChange={e=>updateStudent(s.id,{ criteria:{ ...(s.criteria||{}), [c.label]: e.target.value } })}
              onBlur={e=>updateStudent(s.id,{ criteria:{ ...(s.criteria||{}), [c.label]: e.target.value === '' ? 0 : Number(e.target.value) } })}
              />
              </div>
            ))}
            </div>
            </div>
            </div>
          )
        })}
        </div>
        </div>
        </div>

        {/* ADD STUDENT MODAL */}
        <Modal open={showAdd} onClose={()=>{ setShowAdd(false); setDraftStudent(null) }} title="Add New Student">
        {draftStudent && (
          <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
          <Field label="First Name"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.firstName} onChange={e=>setDraftStudent(ds=>({...ds, firstName:e.target.value}))} autoFocus /></Field>
          <Field label="Last Name"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.lastName} onChange={e=>setDraftStudent(ds=>({...ds, lastName:e.target.value}))} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-4">
          <Field label="Gender">
          <select className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.gender} onChange={e=>setDraftStudent(ds=>({...ds, gender:e.target.value}))}>
          <option value="">—</option><option value="M">M</option><option value="F">F</option>
          </select>
          </Field>
          <Field label="Prev Teacher"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.previousTeacher} onChange={e=>setDraftStudent(ds=>({...ds, previousTeacher:e.target.value}))} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
          {criteria.map(c => (
            <Field key={c.label} label={c.label}>
            <input type="number" className="border-slate-300 dark:border-slate-600 rounded px-2 py-1 w-full text-right bg-white dark:bg-slate-800 dark:text-white" value={(draftStudent.criteria?.[c.label] ?? 0)} onChange={e=>setDraftStudent(ds=>({ ...ds, criteria: { ...(ds.criteria||{}), [c.label]: Number(e.target.value) } }))} />
            </Field>
          ))}
          </div>
          <div className="flex justify-end pt-4">
          <button className="px-6 py-2 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700" onClick={submitAddStudent}>Add Student</button>
          </div>
          </div>
        )}
        </Modal>
        </div>
  )
}
