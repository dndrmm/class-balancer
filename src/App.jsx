import React, { useState, useEffect, useMemo, useRef } from 'react'

/* =========================
   Helpers, caches, constants
   ========================= */
// Decides if a column is likely a grade/score (mostly numbers) or text
const mostlyNumeric = (vals) => {
  const nonEmpty = vals.filter(x => x && String(x).trim() !== '')
  if (nonEmpty.length === 0) return false
    const numCount = nonEmpty.filter(x => !isNaN(parseFloat(x))).length
    return (numCount / nonEmpty.length) > 0.5
}

// Splits CSV lines while respecting "quoted, commas"
const splitCSV = (str) => {
  const result = []
  let current = ''
  let inQuote = false
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (char === '"') {
      inQuote = !inQuote
    } else if (char === ',' && !inQuote) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  result.push(current)
  return result.map(s => s.trim().replace(/^"|"$/g, ''))
}
const scoreCache = new Map()
const metersCache = new Map()
// Core fields for CSV parsing. 'id' is now only an internal key.
const CORE_FIELDS = new Set(['id','firstname','lastname','gender','tags','notes','previousteacher','previous_teacher', 'name'])
const norm = (s)=> String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'')

const VERSION = 'v1.0.1' // Incremented for stability fixes
const BUILTIN_TAGS = ['504','IEP','ELL','Gifted','Speech']

// Map button labels to actual weight values
const WEIGHT_MAP = {
  'Low': 0.5,
  'Normal': 1.0,
  'High': 2.0,
  0.5: 'Low',
  1.0: 'Normal',
  2.0: 'High'
};

// LOOKUP: Maps letters A-Z to 1-26 for standardized level conversion (Guided Reading, etc.).
const LETTER_GRADE_MAP = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    map[letter] = i + 1;
  }
  return map;
})();

function makeCriteriaVersion(criteria){
  // Criteria version string affects cache key
  return criteria.map(c=>`${c.label}:${c.weight}:${c.max}`).join('|')
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
  
  // LOGIC: If student scores are ignored (e.g., Pull-out programs), return 0
  if (s.ignoreScores) {
     scoreCache.set(key, 0);
     return 0;
  }

  // Sum criteria values, normalized by weight
  const val = criteria
    .reduce((acc, c) => {
      const v = Number(s.criteria?.[c.label]) || 0
      const w = Number(c.weight) || 0
      return acc + v * w
    }, 0)

  scoreCache.set(key, val)
  return val
}

function getAverageCriteriaScore(studentsById, allIds, criterionLabel) {
    // Only calculate average among students whose scores are NOT ignored
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
    
    // Calculate meter percentage (pct) based on the calculated average
    const pct = Math.max(0, Math.min(100, (avg/(c.max||100))*100))
    
    const globalAvg = getAverageCriteriaScore(studentsById, allIds, c.label);
    const deviation = avg - globalAvg;
    const deviationPct = (deviation / (globalAvg || 1)) * 100; 
    
    let colorClass = 'bg-emerald-600 dark:bg-emerald-500'; 
    let labelText = 'Balanced';
    
    if (deviation < 0) {
        if (deviationPct <= -15) { 
            colorClass = 'bg-red-600 dark:bg-red-500';
            labelText = 'Far Below Average'; 
        } else if (deviationPct <= -10) {
            colorClass = 'bg-yellow-600 dark:bg-yellow-500';
            labelText = 'Below Average'; 
        }
    } else if (deviation > 0) {
        if (deviationPct >= 10) { 
            colorClass = 'bg-blue-600 dark:bg-blue-500';
            labelText = 'Above Average'; 
        }
    } else {
        colorClass = 'bg-emerald-600 dark:bg-emerald-500';
        labelText = 'Balanced';
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

  // union-find for keep-together
  const parent = new Map(allIds.map(id=>[id,id]))
  const find = (x)=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra, rb) }
  for(const [a,b] of keepTogetherPairs){ if(a && b) union(a,b) }

  const comps = new Map()
  allIds.forEach(id => { const r=find(id); if(!comps.has(r)) comps.set(r, []); comps.get(r).push(id) })

  // turn components into placeable "units", propagate pins if consistent
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
      // split inconsistent pins
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

  // helpers for "need" and gender tiebreak
  const classAvg = (ci) => {
    const ids = classes[ci].studentIds
    if (!ids.length) return 0
    // FIX: Class average calculation must ignore students with ignoreScores = true
    const relevantIds = ids.filter(id => !studentsById.get(id)?.ignoreScores);
    if (relevantIds.length === 0) return 0;
    
    const total = relevantIds.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv), 0)
    return total / relevantIds.length
  }
  const unitAvg = (ids) => ids.length? ids.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv),0)/ids.length : 0
  const classAvgAfter = (ci, unitIds) => {
    // FIX: Ensure calculation ignores ignored students
    const existingRelevantIds = classes[ci].studentIds.filter(id => !studentsById.get(id)?.ignoreScores);
    const incomingRelevantIds = unitIds.filter(id => !studentsById.get(id)?.ignoreScores);
    
    const currentN = existingRelevantIds.length;
    const incomingN = incomingRelevantIds.length;

    if (currentN + incomingN === 0) return 0;
    
    const currentTotal = existingRelevantIds.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv), 0);
    const addTotal = incomingRelevantIds.reduce((a,id)=> a + getCompositeScore(studentsById,id,criteria,cv), 0);
    
    return (currentTotal + addTotal) / (currentN + incomingN);
  }
  const genderCounts = (ids=[]) => {
    let M=0, F=0
    for(const id of ids){
      const g = studentsById.get(id)?.gender
      if(g==='M') M++; else if(g==='F') F++
    }
    return {M,F}
  }
  
  // FIX: pickByGenderImbalance is now defined above, so it can be called here
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

  // place pinned units
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

  // place free units
  for(const unit of freeUnits){
    const sizes = classes.map(c=>c.studentIds.length)
    const minSize = Math.min(...sizes)
    let candidates = sizes
      .map((sz,i)=> (sz===minSize? i : null))
      .filter(i=>i!==null)
      .filter(i => fitsClass(unit,i) && !violatesApartUnit(unit,i))
    if(!candidates.length){
      const sorted = classes.map((c,i)=>({i, size:c.studentIds.length})).sort((a,b)=>a.size-b.size).map(x=>x.i)
      candidates = sorted.filter(i => !violatesApartUnit(unit,i))
      if(!candidates.length) candidates = sorted
    }
    const chosen = pickByClassNeedThenGender(candidates, unit.ids)
    classes[chosen].studentIds.push(...unit.ids)
  }

  // dedupe just in case
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
  // union-find for keep-together
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
  // Sort ALL units from highest score to lowest score
  freeUnits.sort((a,b)=> unitScore(b.ids) - unitScore(a.ids))

  // --- Strict Cut-Point Assignment Logic ---
  
  // 1. Place pinned units first
  for(const unit of pinnedUnits){
    const ci = unit.target
    if(!violatesApartUnit(unit, ci)){
      classes[ci].studentIds.push(...unit.ids)
    } else {
      // If pinned unit violates constraint/capacity, try to place it close by
      const order = [...Array(n).keys()]
      let placed=false
      for(const alt of order){
        if(fitsClass(unit, alt) && !violatesApartUnit(unit, alt)) { classes[alt].studentIds.push(...unit.ids); placed=true; break }
      }
      // If still fails, force it into the pinned class (may violate capacity/constraint)
      if(!placed) classes[ci].studentIds.push(...unit.ids)
    }
  }

  // 2. Place free units sequentially based on sorted order
  let currentClassIndex = 0;
  for(const unit of freeUnits){
    let placed = false;
    
    // Attempt to place in the current target class (highest score class = Class 1, etc.)
    for (let i = currentClassIndex; i < n; i++) {
        if (fitsClass(unit, i) && !violatesApartUnit(unit, i)) {
            classes[i].studentIds.push(...unit.ids);
            currentClassIndex = i; // Stay on this class until it's full
            placed = true;
            break;
        }
    }

    // If it couldn't fit in the ideal class or subsequent classes (due to capacity/constraint),
    // try any class to ensure all students are placed (but prioritize nearest valid)
    if (!placed) {
      const order = [...Array(n).keys()].sort((a,b)=>a-b);
      for(const alt of order){
        if(fitsClass(unit, alt) && !violatesApartUnit(unit, alt)) { classes[alt].studentIds.push(...unit.ids); placed=true; break }
      }
      // Worst case: force placement in the last checked spot (shouldn't happen with capacity checks)
      if(!placed) classes[currentClassIndex].studentIds.push(...unit.ids)
    }
    
    // After placing a unit, if the current class is full, advance the pointer
    // We only advance the pointer AFTER the unit has been placed.
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
  const hasId = headersNorm.includes('id')
  const hasFirst = headersNorm.includes('firstname')
  const hasLast = headersNorm.includes('lastname')
  const hasSingleName = headersNorm.includes('name')

  const body = lines.slice(1);
  const rows = body.map(splitCSV);
  
  const colCells = headersRaw.map((_,i)=> rows.map(r=>r[i]??''))
  const coreFieldsSet = new Set(['id', 'firstname', 'lastname', 'name', 'gender', 'tags', 'notes', 'previousteacher', 'previous_teacher'])
  const criteriaLabels = headersRaw.filter((h,i)=> !coreFieldsSet.has(headersNorm[i]) && mostlyNumeric(colCells[i]||[]) )

  // 1. Determine max score (and collect parsed numerical values) for each criterion
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
                // Convert letter grade (e.g., A, B, C) to number (1, 2, 3)
                value = LETTER_GRADE_MAP[rawValue.toUpperCase()] || 0;
            }
        }
        
        values.push(value);
        if (value > max) {
          max = value;
        }
      });
    }
    
    maxScores[label] = max > 0 ? max : 100;
    parsedCriteriaValues.set(label, values);
  });


  // 2. Create student objects using the parsed numerical values
  const students=[]
  for(let r=0;r<rows.length;r++){
    const cols=rows[r]; 
    const byNorm={}; 
    // FIX: Corrected the syntax error in the assignment: byNorm[hn] = (cols[i]??'').trim()
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

/* =========================
   UI: Modal
   ========================= */
function Modal({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-[min(700px,92vw)] max-h-[86vh] overflow-auto border"
        onClick={(e)=>e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">{title}</div>
          <button className="text-sm px-2 py-1 rounded border" onClick={onClose}>Close</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

/* =========================
   Manual Pins sub-component
   ========================= */
function ManualPins({ allIds, studentsById, numClasses, setStudentsById, classes, setBlockedMoveMessage }){ // ADDED setBlockedMoveMessage
  const [selectedId, setSelectedId] = useState(allIds[0]||null)
  const [constraintSearch, setConstraintSearch] = useState('');

  useEffect(()=>{
    if(!selectedId && allIds.length) setSelectedId(allIds[0])
    if(selectedId && !allIds.includes(selectedId)) setSelectedId(allIds[0]||null)
  }, [allIds, selectedId])

  const s = selectedId ? studentsById.get(selectedId) : null
  const sortedIds = useMemo(()=> [...allIds].sort((a,b)=> (studentsById.get(a)?.name||'').localeCompare(studentsById.get(b)?.name||'')), [allIds, studentsById])

  function patchStudent(id, patch){
    setStudentsById(prev=>{ const m=new Map(prev); m.set(id, { ...m.get(id), ...patch }); return m })
  }

  // FIX: Updated patchStudent to handle batch updates to the map
  function batchPatchStudents(updates){
    setStudentsById(prev=>{ 
        const m=new Map(prev); 
        updates.forEach(({id, patch}) => {
             m.set(id, { ...m.get(id), ...patch }); 
        });
        return m 
    })
  }
  
  // Deprecated single patch function (kept for other component parts if needed)
  function patchStudent(id, patch){
     batchPatchStudents([{id, patch}]);
  }

  const togglePin = (type, targetId) => {
    
    const targetStudent = studentsById.get(targetId);
    const selectedStudentName = s?.name || selectedId;
    const targetStudentName = targetStudent?.name || targetId;
    
    // --- Determine Constraint Types ---
    const isSettingKeepWith = type === 'pinKeepWith';
    const currentArray = s?.[type] || [];
    const isCurrentlySet = currentArray.includes(targetId);

    if (isCurrentlySet) {
        // --- ACTION: REMOVE CONSTRAINT ---
        const newArray = currentArray.filter(id => id !== targetId);
        
        // RECIPROCAL ACTION: Remove the reciprocal constraint from targetId
        const reciprocalType = isSettingKeepWith ? 'pinKeepWith' : 'pinKeepApart';
        const targetArray = targetStudent?.[reciprocalType] || [];
        const newTargetArray = targetArray.filter(id => id !== selectedId);
        
        // Batch update both students
        batchPatchStudents([
            { id: selectedId, patch: { [type]: newArray } },
            { id: targetId, patch: { [reciprocalType]: newTargetArray } }
        ]);
        return;
    } 
    
    // --- ACTION: ADD NEW CONSTRAINT ---
    
    // 1. Check for IMPOSSIBLE CONFLICT on the TARGET student's record
    
    // If setting A(Keep With) B, check B's record for "Separate From A"
    if (isSettingKeepWith && (targetStudent?.pinKeepApart || []).includes(selectedId)) {
        setBlockedMoveMessage(
            `Cannot set "${selectedStudentName} Keep With ${targetStudentName}". ${targetStudentName} is already set to be SEPARATED FROM ${selectedStudentName}. Please remove the existing constraint on ${targetStudentName}'s record first.`
        );
        return;
    }
    
    // If setting A(Separate From) B, check B's record for "Keep With A"
    if (!isSettingKeepWith && (targetStudent?.pinKeepWith || []).includes(selectedId)) {
        setBlockedMoveMessage(
            `Cannot set "${selectedStudentName} Separate From ${targetStudentName}". ${targetStudentName} is already set to be KEPT WITH ${selectedStudentName}. Please remove the existing constraint on ${targetStudentName}'s record first.`
        );
        return;
    }


    // 2. No conflict detected: ADD constraint and RECIPROCAL constraint
    const newArray = [...currentArray, targetId].filter(id => id !== selectedId);

    const reciprocalType = isSettingKeepWith ? 'pinKeepWith' : 'pinKeepApart';
    const targetArray = targetStudent?.[reciprocalType] || [];
    let newTargetArray = targetArray;
    
    if (!targetArray.includes(selectedId)) {
        newTargetArray = [...targetArray, selectedId];
    }
    
    // Batch update both students
    batchPatchStudents([
        { id: selectedId, patch: { [type]: newArray } },
        { id: targetId, patch: { [reciprocalType]: newTargetArray } }
    ]);
  };
  
  const getButtonClass = (targetId, currentArray) => {
    const isActive = currentArray.includes(targetId);
    return `px-2 py-1 text-xs rounded-full border transition duration-150 truncate ${
      isActive
        ? 'bg-blue-500 text-white border-blue-600'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`;
  };

  // Get class name based on index
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <div className="lg:col-span-4">
        <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Student Focus</div>
        <select className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                value={selectedId||''}
                onChange={e=>setSelectedId(e.target.value||null)}>
          <option value="">(Select Student)</option>
          {sortedIds.map(id => <option key={id} value={id}>{studentsById.get(id)?.name}</option>)}
        </select>
        
        {s && (
          <div className="mt-3">
            <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Pin to Class</div>
            <select className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                    value={s?.pinClass ?? ''}
                    onChange={e=>{
                      const v = e.target.value==='' ? null : Number(e.target.value)
                      patchStudent(selectedId, { pinClass: v })
                    }}>
              <option value="">None</option>
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
          <div key={type} className="lg:col-span-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
                {isKeepWith ? 'Keep With (Group)' : 'Separate From (Conflict)'}
              </div>
              <button className="text-xs underline text-red-500" onClick={()=>batchPatchStudents([{id:selectedId, patch:{[type]:[]}}])}>Clear All</button>
            </div>
            
            {/* NEW: Search Input */}
            <input
              type="text"
              value={constraintSearch}
              onChange={(e) => setConstraintSearch(e.target.value)}
              placeholder="Search student to add/remove..."
              className="w-full p-2 border rounded-lg mb-3 bg-white dark:bg-gray-800 text-sm"
            />
            
            <div className="border rounded-xl p-2 max-h-48 overflow-y-auto flex flex-wrap gap-2 bg-gray-50 dark:bg-gray-800">
              
              {/* Display SELECTED students first */}
              {currentArray.map(id => {
                 const studentName = studentsById.get(id)?.name;
                 return (
                  <button
                    key={id}
                    onClick={() => togglePin(type, id)}
                    className={getButtonClass(id, currentArray)}
                    title={`Remove constraint with ${studentName}`}
                  >
                    ✔ {studentName}
                  </button>
                 );
              })}
              
              {/* Display FILTERED, UNSELECTED students */}
              {filteredStudents
                .filter(id => !currentArray.includes(id))
                .map(id => {
                  const studentName = studentsById.get(id)?.name;
                  return (
                    <button
                      key={id}
                      onClick={() => togglePin(type, id)}
                      className={getButtonClass(id, currentArray)}
                      title={`Add constraint with ${studentName}`}
                    >
                      + {studentName}
                    </button>
                  );
                })}

              {filteredStudents.length === 0 && constraintSearch && (
                <p className="text-gray-500 text-xs p-2">No results for "{constraintSearch}"</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================
   MAIN APP COMPONENT (state + top utilities)
   ========================================== */
export default function App(){
  const [dark, setDark] = useState(false)
  useEffect(()=>{ document.documentElement.classList.toggle('dark', dark) }, [dark])

  const [studentsById, setStudentsById] = useState(new Map())
  const [allIds, setAllIds] = useState([])
  // FIX: criteria is now empty by default
  const [criteria, setCriteria] = useState([])
  const [classMeta, setClassMeta] = useState([])
  const [classes, setClasses] = useState([])
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('overallHigh') // Default sort mode updated
  // FIX: Declared numClasses first
  const [numClasses, setNumClasses] = useState(6)
  
  // add this with the other useState hooks in App()
const [newCritName, setNewCritName] = useState('');

  // NEW: State to track manual overrides and the confirmation modal
  const [hasManualChanges, setHasManualChanges] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  // NEW: State for blocked move notification
  const [blockedMoveMessage, setBlockedMoveMessage] = useState(null);


  const [mode, setMode] = useState('balanced') // 'balanced' | 'leveled'
  const [levelOn, setLevelOn] = useState('Reading') // or 'Composite'

  // cached version keys
  const criteriaVersion = useMemo(()=> makeCriteriaVersion(criteria), [criteria])

  // drag + drop
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
        // FIX: Trigger MODAL for blocked move instead of a banner
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
      // CRITICAL ADDITION: Manually setting the student's pinClass when dragged
      // This ensures the student stays in the new class if Auto Place is run again.
      const s = { ...m.get(sid), pinClass: toIdx } 
      m.set(sid, s)
      return m
    })
    dragRef.current = null

    // NEW: Mark that a manual change has occurred
    setHasManualChanges(true);
  }

  // clear caches when inputs change
  useEffect(() => { scoreCache.clear(); metersCache.clear() }, [studentsById, criteria])
  /* ---------- student ops ---------- */
  function updateStudent(id, patch){
    setStudentsById(prev => { 
        const s = prev.get(id);
        const newStudent = { ...s, ...patch };
        
        // Handle name change and split
        if (patch.firstName !== undefined || patch.lastName !== undefined || patch.name !== undefined) {
            let fn = patch.firstName !== undefined ? patch.firstName : (s.firstName || '');
            let ln = patch.lastName !== undefined ? patch.lastName : (s.lastName || '');

            if (patch.name !== undefined) {
                 // If updating full name, try to split it into first/last
                const parts = patch.name.trim().split(/\s+/);
                fn = parts.shift() || '';
                ln = parts.join(' ') || '';
            }
            
            newStudent.firstName = fn;
            newStudent.lastName = ln;
            newStudent.name = `${fn} ${ln}`.trim();
        }
        
        // FIX: Explicitly set hasManualChanges to true if any student data is updated
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

  // ------- Add Student modal + single-student auto-place -------
  const [lastAddMsg, setLastAddMsg] = useState('')
  const [lastAddedId, setLastAddedId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [draftStudent, setDraftStudent] = useState(null)
  
  // Custom state for general UI messages
  const [statusMessage, setStatusMessage] = useState({ message: '', type: 'success' });

  // Function to display messages and clear them after a delay
  const displayStatus = (message, type = 'success', duration = 4000) => {
    setStatusMessage({ message, type });
    setTimeout(() => setStatusMessage({ message: '', type: 'success' }), duration);
  };
  
  function openAddStudent(){
    // Use only active criteria (weight > 0)
    const activeCriteria = criteria.filter(c => (c.weight ?? 0) > 0);
    const crit = {}; activeCriteria.forEach(c=>{ crit[c.label]=0 })
    setDraftStudent({
      firstName: '', // NEW
      lastName: '', // NEW
      name:'', id:'', gender:'', previousTeacher:'', notes:'', tags:'', criteria:crit
    })
    setShowAdd(true)
  }
  function submitAddStudent(){
    if(!draftStudent) return
    
    // FIX: Use first/last name fields
    let firstName = (draftStudent.firstName||'').trim();
    let lastName = (draftStudent.lastName||'').trim();
    
    // Fallback if only 'name' was used in the modal (for simplicity)
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

    // FIX: Simplified ID generation
    const baseRaw = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let newId = baseRaw; 
    let n=1;
    // Check for ID conflict against existing students (using names to generate ID)
    while(studentsById.has(newId) || newId === '') { 
      newId = baseRaw + (++n); 
    }

    const tags = (draftStudent.tags||'').split(/[|,;/]/).map(t=>t.trim()).filter(Boolean)
    const student = {
      id:newId,
      firstName: firstName, // NEW
      lastName: lastName,   // NEW
      name: fullName,       // NEW
      gender: draftStudent.gender || undefined,
      previousTeacher: draftStudent.previousTeacher || '',
      notes: draftStudent.notes || '',
      tags,
      criteria: { ...(draftStudent.criteria||{}) },
      pinClass: null,
      pinKeepWith: [],
      pinKeepApart: []
    }

    // add to map, then decide class based on current classes
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
  
  // All state variables that runAutoPlace depends on
  const runAutoPlaceDeps = [
    studentsById, 
    allIds, 
    numClasses, 
    criteria, 
    mode, 
    levelOn,
    classMeta,
  ];

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
    // NEW: Clear manual changes flag after a full algorithm run
    setHasManualChanges(false);
  }
  
  // FIX: Run autoPlace ONLY when critical configuration/roster changes, NOT on manual class drag/drop
  useEffect(()=>{ 
      // Only run if studentsById or criteria changes, or if classes are initially empty 
      if (allIds.length > 0 && classes.length === 0) {
        runAutoPlace();
      }
  }, [studentsById, allIds.length, numClasses, criteria, mode, levelOn]); 

  // Function called when the user presses the main button
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
    // FIX: Adjusted class styling to force a square chip and center the text, resolving the 'F' oval issue.
    // Use fixed w-4 h-4 with flex centering and remove unnecessary py-0.5 to control sizing.
    if (gender === 'F') return 'bg-pink-100 text-pink-700 border-pink-300 px-1 text-[10px] w-4 h-4 flex items-center justify-center';
    if (gender === 'M') return 'bg-blue-100 text-blue-700 border-blue-300 px-1 text-[10px] w-4 h-4 flex items-center justify-center';
    return 'bg-gray-200 text-gray-600 border-gray-400 px-1 text-[10px] w-4 h-4 flex items-center justify-center';
  };


  /* ---------- Toolbar field helper ---------- */
  function Field({ label, children }) {
    return (
      <div className="flex flex-col gap-1 min-w-[140px]">
        <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">{label}</div>
        {children}
      </div>
    );
  }

  /* ---------- CSV/JSON I/O ---------- */
  function exportCSV(){
    // 1. Map students to their assigned class name
    const studentClassMap = new Map();
    classes.forEach(cls => {
      cls.studentIds.forEach(id => {
        studentClassMap.set(id, cls.name);
      });
    });

    // 2. Define headers, EXCLUDING 'id'
    const headers = ['Class Name', 'First Name','Last Name','gender','tags','notes','Previous Teacher', ...criteria.map(c=>c.label)] // ID and name removed
    
    // 3. Populate rows
    const rows = allIds.map(id => {
      const s = studentsById.get(id)
      const className = studentClassMap.get(id) || 'Unassigned';
      
      const base = [ 
        className, // Class Name
        s.firstName || '', // First Name
        s.lastName || '', // Last Name
        s.gender||'', 
        (s.tags||[]).join('; '), 
        (s.notes||'').replaceAll('\n',' '), 
        s.previousTeacher||'' 
      ]
      const crit = criteria.map(c => Number(s.criteria?.[c.label]) || 0)
      return base.concat(crit)
    })
    
    // 4. Sort rows by Class Name (the first column)
    rows.sort((a, b) => a[0].localeCompare(b[0]));

    const csv = [headers.join(','), ...rows.map(r=>r.join(','))].join('\n')
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'balanced-class-roster.csv'; a.click(); URL.revokeObjectURL(url)
  }
  async function importCSV(file){
    try {
      const {students, criteriaLabels, maxScores} = safeParseCSV(await file.text()) // FIX: Await file.text()
      if(!students.length) throw new Error('No rows detected. Make sure first row is headers and rows follow.')
      
      let critMerged=[]
      criteriaLabels.forEach(label => {
        // FIX: Use the calculated max score, and default weight to 1.0 (Normal)
        const max = maxScores[label] || 100;
        critMerged.push({ label, weight:1.0, max: max, enabled: true });
      })
      
      const map=new Map(); 
      const ids=[];
      
      // Ensure all students have unique IDs if needed after import
      students.forEach(st => {
        let currentId = st.id;
        let n = 1;
        const baseNameId = `${st.firstName}${st.lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
        
        // Handle name conflicts by ensuring ID is truly unique after initial parse attempt
        while(map.has(currentId)) {
            currentId = baseNameId + (++n);
        }
        
        const merged={...(st.criteria||{})}
        critMerged.forEach(c => { if(merged[c.label]===undefined || Number.isNaN(merged[c.label])) merged[c.label]=0 })
        const pinReady = { pinClass: st.pinClass ?? null, pinKeepWith: st.pinKeepWith ?? [], pinKeepApart: st.pinKeepApart ?? [] }
        // FIX: Ensure new student objects are created with the ignoreScores default
        const cleanSt = { ...st, ignoreScores: st.ignoreScores ?? false }; delete cleanSt.enabled; 

        map.set(currentId, {...cleanSt, ...pinReady, criteria:merged, id: currentId}); 
        ids.push(currentId);
      })
      
      setCriteria(critMerged); setStudentsById(map); setAllIds(ids); setClassMeta([])
      setClasses([]); 
      displayStatus(`Imported ${ids.length} students and ${criteriaLabels.length} balancing factors from "${file.name}".`, 'success');
      setHasManualChanges(false); // Reset manual changes flag on fresh import
      
    } catch (err) {
      console.error('CSV import failed:', err);
      // Replaced alert()
      displayStatus('Load failed: '+(err?.message||err), 'error', 6000);
    }
  }
  function exportJSON(){
    const payload = {
      version: 'bcs-1',
      numClasses,
      criteria: criteria.map(({ enabled, ...rest }) => rest), // Strip 'enabled' flag on export
      students: Array.from(studentsById.values()),
      classMeta,
      classes,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'bcs-session.json'; a.click(); URL.revokeObjectURL(url)
  }
  async function importJSON(file){
    try {
      const text = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result||''))
        r.onerror = () => reject(new Error('Could not read file'))
        r.readAsText(file)
      })
      let data
      try{ data = JSON.parse(text) } catch(e){ throw new Error('Invalid JSON') }
      if(!data || typeof data !== 'object') throw new Error('Invalid JSON structure')
      if(!Array.isArray(data.students)) throw new Error('Missing "students" array')
  
      const map = new Map()
      const ids = []
      for(const s of data.students){
        if(!s || !s.id) continue
        
        // Ensure student object has firstName and lastName
        let fn = s.firstName || '';
        let ln = s.lastName || '';
        if (!fn && !ln && s.name) {
            const parts = s.name.split(/\s+/);
            fn = parts.shift() || '';
            ln = parts.join(' ') || '';
        }
        
        // FIX: Ensure incoming students are created with the ignoreScores property
        const newStudent = { pinClass:null, pinKeepWith:[], pinKeepApart:[], ignoreScores: false, ...s, firstName: fn, lastName: ln, name: `${fn} ${ln}`.trim() };
        map.set(s.id, newStudent);
        ids.push(s.id);
      }
      setStudentsById(map)
      setAllIds(ids)
      // Process criteria, ensuring 'enabled' is removed if present
      if(Array.isArray(data.criteria)) {
        const processedCriteria = data.criteria.map(c => {
          if (c.enabled === undefined) c.enabled = (c.weight ?? 0) > 0; // Default to shown if weight > 0 or not defined
          return c;
        });
        setCriteria(processedCriteria);
      }
      if(typeof data.numClasses === 'number' && data.numClasses > 0) setNumClasses(data.numClasses)
      if(Array.isArray(data.classMeta)) setClassMeta(data.classMeta)
      if(Array.isArray(data.classes)) setClasses(data.classes)
      // Replaced alert()
      displayStatus(`Loaded ${ids.length} students from JSON.`, 'success');
      setHasManualChanges(false); // Reset manual changes flag on session load
            } catch(err) {
      console.error('JSON import failed:', err);
      // Replaced alert()
      displayStatus('Load failed: '+(err?.message||err), 'error', 6000);
    }
  }

  // --- Weight Toggles and Mapping ---
  const handleWeightChange = (label, newWeightLabel) => {
    const newWeight = WEIGHT_MAP[newWeightLabel];
    if (newWeight === undefined) return;

    setCriteria(prev => prev.map(c => 
      c.label === label ? { ...c, weight: newWeight } : c
    ));
    setHasManualChanges(true);
  };

  const getWeightLabel = (weight) => {
    return WEIGHT_MAP[weight] || 'Custom';
  };
  
  // --- Show/Hide Toggle ---
  const handleShowToggle = (label) => {
    setCriteria(prev => prev.map(c => 
      c.label === label ? { ...c, enabled: !c.enabled } : c
    ));
    // NOTE: Does not setHasManualChanges, as this only affects visualization, not the sorting algorithm itself (which uses weight > 0)
  };

  /* ============================
     BEGIN RENDER (Toolbar first)
     ============================ */
  return (
    <div>
      {/* 1. Confirm Re-Balancing Modal */}
      <Modal
        open={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        title="Confirm Re-Balancing"
      >
        <div className="text-gray-700 dark:text-gray-300">
          <p className="mb-4">You have made manual changes to the class rosters since the last automated run.</p>
          <p className="font-bold text-red-600">
            Running the Class Balancing algorithm will overwrite and reset all manual drag-and-drop assignments.
          </p>
          <p className="mt-2">
            Do you wish to proceed? (Manual pins set in the "Manual Pins & Relationships" section will be respected.)
          </p>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={() => setShowConfirmModal(false)}
            className="px-4 py-2 rounded border bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmRun}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700"
          >
            Yes, Run and Overwrite
          </button>
        </div>
      </Modal>

      {/* 4. Blocked Move Modal (Non-blocking replacement for displayStatus) */}
      <Modal
        open={!!blockedMoveMessage}
        onClose={() => setBlockedMoveMessage(null)}
        title="Constraint Violation"
      >
        <div className="text-gray-700 dark:text-gray-300">
          <p className="font-bold text-red-600 mb-4">Constraint Error</p>
          <p>{blockedMoveMessage}</p>
          <p className="mt-4">Please remove the conflicting constraint in the "Manual Pins & Relationships" section before proceeding.</p>
        </div>
        <div className="flex justify-end mt-6">
          <button
            onClick={() => setBlockedMoveMessage(null)}
            className="px-4 py-2 rounded bg-gray-600 text-white hover:bg-gray-700"
          >
            Acknowledge
          </button>
        </div>
      </Modal>


      {/* Toolbar */}
      <div className="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur border-b no-print">
        <div className="max-w-9xl mx-auto px-6 py-3 space-space-y-3">
          {/* Row 1: Title + version | Theme + Print */}
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-3">
              <div className="text-2xl font-extrabold tracking-tight">
                Class <span className="text-blue-600">Balancer</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full border text-gray-600 dark:text-gray-300">
                {VERSION}
              </span>
              {/* FIX: Moved Dark Mode toggle right after version for cohesive display */}
              <button onClick={()=>setDark(d=>!d)} className="px-2 py-1 border rounded text-sm ml-2">
                {dark ? '🌙' : '☀️'}
              </button>
            </div>
            {/* START: Promoted Utility Bar */}
            
            <div className="ml-auto flex flex-wrap items-center gap-2">
              
              {/* Roster Import/Export (Left Group) */}
              <div className="flex items-center gap-2">
                <button
                  onClick={()=>document.getElementById('csvInput')?.click()}
                  className="px-3 py-2 rounded bg-purple-600 text-white text-sm hover:bg-purple-700 transition"
                >
                  Import Roster
                </button>
                <input id="csvInput" type="file" accept=".csv,text/csv" className="hidden" onChange={(e)=>{ const f=e.target.files?.[0]; if(!f) return; importCSV(f).finally(()=>{ e.target.value='' }) }}/>
                <button onClick={exportCSV} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700 transition">
                  Export Roster
                </button>
              </div>
              
              <div className="border-l border-gray-300 dark:border-gray-600 h-6 mx-2" />

              {/* Session Load/Save (Middle Group) */}
              <div className="flex items-center gap-2">
                <button
                  onClick={()=>document.getElementById('jsonInput')?.click()}
                  className="px-3 py-2 rounded bg-teal-700 text-white text-sm hover:bg-teal-800 transition"
                >
                  Load Session
                </button>
                <input id="jsonInput" type="file" accept="application/json,.json" className="hidden" onChange={(e)=>{ const f=e.target.files?.[0]; if(!f) return; importJSON(f).finally(()=>{ e.target.value='' }) }}/>
                <button onClick={exportJSON} className="px-3 py-2 rounded bg-teal-500 text-white text-sm hover:bg-teal-600 transition">
                  Save Session
                </button>
              </div>
              
              <div className="border-l border-gray-300 dark:border-gray-600 h-6 mx-2" />

              {/* Print (Rightmost button) */}
              <button onClick={()=>window.print()} className="px-3 py-2 rounded bg-slate-700 text-white text-sm">
                Print / PDF
              </button>
            </div>
            {/* END: Promoted Utility Bar */}
          </div>

          {/* Row 2: Core Configuration */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-gray-200 dark:border-gray-700 mt-3">
            <Field label="Classes">
              <input
                type="number"
                min={1}
                max={20}
                value={numClasses}
                onChange={e=>setNumClasses(parseInt(e.target.value||'1',10))}
                className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
              />
            </Field>

            <Field label="Sort Lists By">
              <select
                className="border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 w-full"
                value={sortMode}
                onChange={e=>setSortMode(e.target.value)}
              >
                {/* FIX: Added Low to High sort option */}
                <option value="overallHigh">Overall Score (High to Low)</option>
                <option value="overallLow">Overall Score (Low to High)</option>
                <option value="lastName">Last Name (A → Z)</option> 
                <option value="firstName">First Name (A → Z)</option> 
              </select>
            </Field>

            <Field label="Mode">
              {/* FIX: Replaced Dropdown with Toggle Buttons */}
              <div className="flex gap-2 w-full">
                {['balanced', 'leveled'].map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 rounded text-sm font-semibold border transition duration-150 flex-grow capitalize ${
                      mode === m
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </Field>

            {/* FIX: Conditional display for Level on */}
            {mode === 'leveled' ? (
              <Field label="Level on">
                <select
                  className="border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 w-full"
                  value={levelOn}
                  onChange={e=>setLevelOn(e.target.value)}
                >
                  {/* FIX: Changed Composite to Overall Score */}
                  <option value="Composite">Overall Score</option>
                  {criteria.map(c => (
                    <option key={c.label} value={c.label}>{c.label}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <div className="hidden lg:block" />
            )}
          </div>

          {/* Row 3: Primary Action Button */}
          <div className="mt-3">
            <button 
              onClick={handleRunBalancingClick} 
              // FIX: Use a responsive max width to prevent it from being too wide
              className={`px-3 py-2 rounded bg-blue-600 text-white text-lg font-bold shadow-xl hover:bg-blue-700 transition duration-200 w-full sm:w-auto ${hasManualChanges ? 'ring-2 ring-red-500' : ''}`}
            >
              Run Class Balancing
              {hasManualChanges && (
                <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-red-500 text-white animate-pulse">
                  ! Manual Edits
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Status Banner (Replaces Alerts) */}
      {statusMessage.message && (
        <div className="max-w-9xl mx-auto px-6 mt-3 no-print">
          <div className={`rounded-lg border px-3 py-2 text-sm 
            ${statusMessage.type === 'error' ? 'border-red-400 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' : 
            statusMessage.type === 'success' ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : 
            'border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300'}`}
          >
            {statusMessage.message}
          </div>
        </div>
      )}

      {/* Criteria */}
      <div className="max-w-9xl mx-auto px-6 mt-4 no-print">
        <div className="rounded-2xl border shadow-sm bg-white dark:bg-gray-900 p-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Balancing Factors</div>
            {/* REMOVED: Redundant explanatory text for Impact Multiplier */}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {criteria.map(c => (
              <div key={c.label} className="border rounded-xl p-2 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium truncate" title={c.label}>{c.label}</div>
                  
                  {/* NEW: Show/Hide Toggle */}
                  <label className="text-xs flex items-center gap-1">
                      <input type="checkbox" checked={c.enabled} onChange={()=>handleShowToggle(c.label)} />
                      <span>Show Meter</span>
                  </label>

                  <button className="text-xs px-2 py-0.5 border rounded" onClick={()=>setCriteria(prev=>prev.filter(x=>x.label!==c.label))}>Remove</button>
                </div>
                
                <div className="grid grid-cols-[auto,1fr] items-center gap-x-2 gap-y-1">
                  
                  {/* NEW: Weight Toggles (Low / Normal / High) */}
                  {/* FIX: Changed label to simply "Importance" */}
                  <div className="text-xs opacity-70">Importance</div>
                  <div className="flex justify-between gap-1 w-full"> {/* FIX: Added w-full to contain buttons */}
                    {['Low', 'Normal', 'High'].map(label => {
                        const value = WEIGHT_MAP[label];
                        const isActive = c.weight === value;
                        return (
                            <button
                                key={label}
                                // FIX: Adjusted flex and padding for better alignment
                                className={`px-2 py-1 text-xs rounded-lg border transition duration-100 text-center flex-grow flex items-center justify-center ${
                                    isActive 
                                        ? 'bg-indigo-500 text-white border-indigo-600'
                                        : 'bg-gray-200 dark:bg-gray-700'
                                }`}
                                onClick={() => handleWeightChange(c.label, label)}
                            >
                                {label}
                            </button>
                        );
                    })}
                  </div>

                  {/* FIX: Simplified Max Score Label */}
                  <div className="text-xs opacity-70">Max Score</div>
                  <input type="number" step={1} value={c.max}
                         onChange={e=>setCriteria(prev=>prev.map(x=>x.label===c.label?{...x,max:parseFloat(e.target.value||'100')}:x))}
                         className="border rounded px-2 py-1 bg-white dark:bg-gray-800 w-[110px]" />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2 items-center">
            <input
              value={newCritName}
              onChange={(e)=>setNewCritName(e.target.value)}
              placeholder="New balancing factor name"
              className="border rounded px-2 py-1 w-64 bg-white dark:bg-gray-800 text-sm"
            />
            <button
              onClick={()=>{
                const label = (newCritName||'').trim()
                if(!label){ 
                  displayStatus('Enter a criterion name.', 'error');
                  return 
                }
                if(criteria.some(c=>c.label===label)){ 
                  displayStatus('That name already exists.', 'error');
                  return 
                }
                // New criterion defaults to weight 1 and max 100, and is shown by default
                setCriteria(prev => [...prev, { label, weight:1.0, max:100, enabled: true }])
                setStudentsById(prev => {
                  const c=new Map(prev)
                  c.forEach(v => { v.criteria = { ...(v.criteria||{}), [label]: 0 } })
                  return c
                })
                setNewCritName('')
              }}
              className="px-3 py-2 rounded bg-green-600 text-white text-sm"
            >
              Add Balancing Factor
            </button>
          </div>
        </div>
      </div>
      {/* Classes Grid */}
      <div className="max-w-9xl mx-auto px-6 mt-4 grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 class-grid">
        {(() => {
          const cls = classes.map((c, idx)=> ({...c, name: classMeta[idx]?.name || c.name, studentIds:[...c.studentIds]}))
          cls.forEach(c => {
            if(sortMode==='overallHigh'){
              c.studentIds.sort((a,b)=> getCompositeScore(studentsById,b,criteria,criteriaVersion) - getCompositeScore(studentsById,a,criteria,criteriaVersion))
            } else if (sortMode === 'overallLow') {
                // NEW SORT LOGIC: Overall Score Low to High
                c.studentIds.sort((a,b)=> getCompositeScore(studentsById,a,criteria,criteriaVersion) - getCompositeScore(studentsById,b,criteria,criteriaVersion));
            } else if (sortMode === 'lastName') { // Last Name A to Z
                c.studentIds.sort((a, b) => (studentsById.get(a)?.lastName || '').localeCompare(studentsById.get(b)?.lastName || ''));
            } else if (sortMode === 'firstName') { // First Name A to Z
                c.studentIds.sort((a, b) => (studentsById.get(a)?.firstName || '').localeCompare(studentsById.get(b)?.firstName || ''));
            } else { // Fallback to Full Name alphabetical
              c.studentIds.sort((a,b)=> (studentsById.get(a)?.name||'').localeCompare(studentsById.get(b)?.name||''))
            }
          })
          
          // CRITICAL: Need to pass allIds into calcMeters now to calculate global average
          const currentAllIds = allIds;
          
          return cls.map((c, idx) => {
            const s = stats(studentsById, c.studentIds)
            // UPDATED: Passing allIds to calcMeters
            const meters = calcMeters(c, studentsById, criteria, currentAllIds, criteriaVersion)
            return (
              <div
                key={c.id}
                className="rounded-2xl border shadow-sm bg-white dark:bg-gray-900 p-3 class-card"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <input className="font-semibold bg-transparent border-b border-dashed focus:outline-none w-48 truncate"
                         value={classMeta[idx]?.name ?? c.name}
                         onChange={e=>{
                           const v=e.target.value
                           setClassMeta(prev=>{ const copy=[...prev]; copy[idx]={ ...(copy[idx]||{}), name:v }; return copy })
                           setClasses(prev=> prev.map((x,i)=> i===idx ? ({...x, name:v}) : x ))
                         }} />
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  Size {s.size} · M {s.M} / F {s.F}
                </div>

                <div className="mt-2 space-y-1 no-print">
                  {meters.map(m => (
                    <div key={m.label} title={`Class Avg: ${m.avg.toFixed(2)} | Roster Avg: ${m.globalAvg.toFixed(2)}`}>
                      <div className="flex justify-between text-[10px] text-gray-500">
                        {/* FIX: Removed raw average score, keeping only percentage */}
                        <span>{m.label}</span><span>{Math.round(m.pct)}%</span>
                      </div>
                      <div className="h-2.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
                        {/* UPDATED: Using dynamic colorClass */}
                        <div className={`h-2.5 ${m.colorClass}`} style={{ width: m.pct+'%' }} />
                      </div>
                      <div className="text-[10px] text-gray-500 flex justify-end">
                        {m.labelText}
                      </div>
                    </div>
                  ))}
                </div>

                <ul
                  className="mt-3 space-y-2 min-h-[200px]"
                  onDragOver={(e)=>e.preventDefault()}
                  onDrop={(e)=>handleDrop(idx, e)}
                >
                  {c.studentIds.map(id => {
                    const st = studentsById.get(id); 
                    if (!st) return null
                    const overall = getCompositeScore(studentsById, id, criteria, criteriaVersion)
                    // FIX: Using the first letter of the criterion label followed by a colon for cleaner display
                    // FIX: Re-added individual scores
                    const bits = criteria.filter(cc => (cc.weight ?? 0) > 0 && cc.enabled).map(cc => `${cc.label.charAt(0)}: ${st.criteria?.[cc.label] ?? 0}`)
                    return (
                      <li
                        key={id}
                        draggable
                        onDragStart={(e) => onDragStartStudent(e, id, idx)}
                        className={
                          "border rounded-xl px-2 py-1 bg-white dark:bg-gray-800 transition-shadow " +
                          (id === lastAddedId ? "ring-2 ring-emerald-500" : "")
                        }
                      >
                        <>
                          <div className="font-medium truncate flex items-center justify-between">
                            {/* FIX: Gender Chip AFTER Name, aligned right */}
                            <span className="truncate">
                                {st.name} 
                            </span>
                            <span className={`text-[10px] font-bold px-1 py-0.5 rounded-full border ${getGenderClass(st.gender)} flex-shrink-0`}>
                              {st.gender?.charAt(0) || '?'}
                            </span>
                          </div>

                          <div className="text-[11px] text-gray-600 dark:text-gray-300">
                            Overall: <span className="font-semibold">{Math.round(overall)}</span>
                            {/* FIX: Re-added individual scores here */}
                            {bits.length ? ' · ' + bits.join(' · ') : ''}
                          </div>

                          {st.previousTeacher ? (
                            <div className="text-[10px] text-gray-500 dark:text-gray-400">
                              Prev: {st.previousTeacher}
                            </div>
                          ) : null}

                          {st.notes ? (
                            <div
                              className="text-[10px] text-gray-500 dark:text-gray-400"
                              style={{
                                overflow: 'hidden',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                whiteSpace: 'normal'
                              }}
                              title={st.notes}
                            >
                              Notes: {st.notes}
                            </div>
                          ) : null}

                          {Array.isArray(st.tags) && st.tags.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {st.tags.map(tag => (
                                <span
                                  key={tag}
                                  className="text-[10px] px-1.5 py-0.5 border rounded-full bg-white dark:bg-gray-800"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })
        })()}
      </div>

      {/* Manual Pins & Relationships */}
      <div className="max-w-9xl mx-auto px-6 mt-6 no-print">
        <div className="rounded-2xl border shadow-sm bg-white dark:bg-gray-900 p-3">
          <div className="text-sm font-semibold mb-2">Manual Pins & Relationships</div>
          <ManualPins
            allIds={allIds}
            studentsById={studentsById}
            numClasses={numClasses}
            setStudentsById={setStudentsById}
            classes={classes} // Passing classes for dynamic names
            setBlockedMoveMessage={setBlockedMoveMessage} // Passing blocked move setter
          />
        </div>
      </div>

      {/* Edit Students */}
      <div className="max-w-9xl mx-auto px-6 mt-6 no-print">
        <div className="rounded-2xl border shadow-sm bg-white dark:bg-gray-900 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="text-sm font-semibold">Edit Students</div>
            <div className="flex items-center gap-2">
              <input
                placeholder="Search student name or tag..." // FIX: Updated placeholder
                className="border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 w-80"
                value={search}
                onChange={e=>setSearch(e.target.value)}
              />
              <button
                onClick={openAddStudent}
                className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm"
              >
                Add Student
              </button>
            </div>
          </div>

          <div className="overflow-auto pr-1" style={{ maxHeight: '500px' }}> {/* FIX: Restored max-height for scrolling */}
            <div className="space-y-2">
              {[...allIds]
                .filter(id => (studentsById.get(id)?.name + id).toLowerCase().includes(search.toLowerCase()))
                .sort((a,b)=> (studentsById.get(a)?.lastName||'').localeCompare(studentsById.get(b)?.lastName||''))
                .map(id=>{
                  const s = studentsById.get(id)
                  return (
                    <div key={id} className="border rounded-lg p-2 text-sm bg-white dark:bg-gray-900">
                      <div className="flex items-center justify-between">
                        <div className="font-medium truncate">
                          {/* FIX: Removed ID from edit list name line */}
                          {s.name} 
                        </div>
                        <button
                          className="text-xs px-2 py-0.5 border rounded text-red-600"
                          onClick={()=>deleteStudent(s.id)}
                        >
                          Delete
                        </button>
                      </div>

                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2"> {/* FIX: Simplified responsive grid */}
                        {/* FIX: Added fields for First Name and Last Name for editing */}
                        <div className="col-span-1 flex flex-col">
                            <div className="text-xs text-gray-600 dark:text-gray-300 mb-0.5">First Name</div>
                            <input
                              className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                              value={s.firstName || ''}
                              onChange={e=>updateStudent(s.id,{ firstName: e.target.value })}
                            />
                        </div>
                        <div className="col-span-1 flex flex-col">
                            <div className="text-xs text-gray-600 dark:text-gray-300 mb-0.5">Last Name</div>
                            <input
                              className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                              value={s.lastName || ''}
                              onChange={e=>updateStudent(s.id,{ lastName: e.target.value })}
                            />
                        </div>

                        <div className="col-span-1 flex flex-col">
                          <div className="text-xs text-gray-600 dark:text-gray-300 mb-0.5">Gender</div>
                          <select
                            className="border rounded px-1 py-1 bg-white dark:bg-gray-800 w-[60px] text-sm"
                            value={s.gender || ''}
                            onChange={e=>updateStudent(s.id,{ gender:e.target.value||undefined })}
                          >
                            <option value="">—</option>
                            <option value="M">M</option>
                            <option value="F">F</option>
                          </select>
                        </div>
                        <div className="col-span-1 flex flex-col">
                          <div className="text-xs text-gray-600 dark:text-gray-300 mb-0.5">Previous Teacher</div>
                          <input
                            className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                            value={s.previousTeacher||''}
                            onChange={e=>updateStudent(s.id,{ previousTeacher: e.target.value })}
                          />
                        </div>
                      </div>

                      {/* NEW: Ignore Scores Checkbox */}
                      <div className="mt-2 border-t pt-2">
                        <label className="flex items-center text-red-500 text-xs gap-2">
                            <input
                                type="checkbox"
                                checked={s.ignoreScores || false}
                                onChange={e => updateStudent(s.id, { ignoreScores: e.target.checked })}
                                className="w-4 h-4 text-red-600 bg-gray-100 border-red-300 rounded focus:ring-red-500"
                            />
                            Do Not Count Scores in Class Average (e.g., for Life Skills)
                        </label>
                      </div>

                      {/* Tags */}
                      <div className="mt-2">
                        <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Tags</div>
                        <div className="flex flex-wrap gap-2 mb-2">
                          {BUILTIN_TAGS.map(t => {
                            const active = (s.tags||[]).includes(t)
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={()=>{
                                  const next = new Set(s.tags||[])
                                  active ? next.delete(t) : next.add(t)
                                  updateStudent(s.id, { tags: Array.from(next) })
                                }}
                                className={
                                  "text-[11px] px-2 py-0.5 rounded-full border " +
                                  (active ? "bg-blue-600 text-white border-blue-600" : "bg-white dark:bg-gray-800")
                                }
                              >
                                {t}
                              </button>
                            )
                          })}
                        </div>

                        <div className="flex gap-2 items-center">
                          <input
                            type="text"
                            placeholder="Add custom tag (e.g., Dyslexia)"
                            className="border rounded px-2 py-1 w-64 bg-white dark:bg-gray-800 text-sm"
                            onKeyDown={(e)=>{
                              if(e.key==='Enter'){
                                const val = e.currentTarget.value.trim()
                                if(!val) return
                                const next = new Set(s.tags||[])
                                next.add(val)
                                updateStudent(s.id, { tags: Array.from(next) })
                                e.currentTarget.value=''
                              }
                            }}
                          />
                          {/* NEW: Add Tag Button */}
                          <button
                            type="button"
                            onClick={(e) => { 
                                const inputElement = e.currentTarget.previousSibling;
                                if (inputElement && inputElement.value.trim()) {
                                    const val = inputElement.value.trim();
                                    const next = new Set(s.tags || []);
                                    next.add(val);
                                    updateStudent(s.id, { tags: Array.from(next) });
                                    inputElement.value = '';
                                }
                            }}
                            className="px-3 py-1.5 rounded bg-gray-300 text-gray-800 text-xs hover:bg-gray-400"
                          >
                            Add
                          </button>
                        </div>
                      </div>

                      {/* Criteria grid */}
                      <div className="mt-2">
                        <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Balancing Factors</div>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                          {criteria.map(c => (
                            <label
                              key={c.label}
                              className="flex items-center justify-between gap-2 border rounded px-2 py-1"
                            >
                              <span className="truncate text-xs" title={c.label}>{c.label}</span>
                              <input
                                type="number"
                                className="border rounded px-2 py-1 w-16 min-w-[3.5rem] text-right bg-white dark:bg-gray-800"
                                value={(s.criteria?.[c.label] ?? '')}
                                onChange={e=>updateStudent(s.id,{
                                  criteria:{ ...(s.criteria||{}), [c.label]: e.target.value }
                                })}
                                onBlur={e=>updateStudent(s.id,{
                                  criteria:{ ...(s.criteria||{}), [c.label]: e.target.value === '' ? 0 : Number(e.target.value) }
                                })}
                              />
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* Notes */}
                      <div className="mt-2">
                        <div className="text-xs text-gray-600 dark:text-gray-300 mb-0.5">Notes</div>
                        <input
                          type="text"
                          placeholder="Optional notes about the student"
                          className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                          value={s.notes||''}
                          onChange={e=>updateStudent(s.id,{ notes: e.target.value })}
                        />
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      </div>

      {/* Add Student Modal */}
      <Modal
        open={showAdd}
        onClose={()=>{ setShowAdd(false); setDraftStudent(null) }}
        title="Add Student"
      >
        {draftStudent && (
          <div className="space-y-4">
            {/* Basic info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">First Name</div>
                <input
                  className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                  value={draftStudent.firstName}
                  onChange={e=>setDraftStudent(ds=>({...ds, firstName:e.target.value}))}
                  placeholder="e.g., Ava"
                  autoFocus
                />
              </div>
              <div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Last Name</div>
                <input
                  className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                  value={draftStudent.lastName}
                  onChange={e=>setDraftStudent(ds=>({...ds, lastName:e.target.value}))}
                  placeholder="e.g., Taylor"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Gender</div>
                <select
                  className="border rounded px-1 py-1 w-full bg-white dark:bg-gray-800 text-sm"
                  value={draftStudent.gender}
                  onChange={e=>setDraftStudent(ds=>({...ds, gender:e.target.value}))}
                >
                  <option value="">—</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Previous Teacher</div>
                <input
                  className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                  value={draftStudent.previousTeacher}
                  onChange={e=>setDraftStudent(ds=>({...ds, previousTeacher:e.target.value}))}
                  placeholder="e.g., Ms. Lopez"
                />
              </div>
              <div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Optional ID (auto if blank)</div>
                {/* NOTE: Hidden from teacher, only used for generating internal ID if primary name fails */}
                <input
                  className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                  value={draftStudent.id}
                  onChange={e=>setDraftStudent(ds=>({...ds, id:e.target.value}))}
                  placeholder="e.g., avatay01"
                />
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Notes</div>
              <input
                type="text"
                className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
                value={draftStudent.notes}
                onChange={e=>setDraftStudent(ds=>({...ds, notes:e.target.value}))}
                placeholder="Optional"
              />
            </div>

            {/* Criteria grid */}
            <div>
              <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Balancing Factors</div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {criteria.map(c => (
                  <label
                    key={c.label}
                    className="flex items-center justify-between gap-2 border rounded px-2 py-1"
                  >
                    <span className="truncate text-xs" title={c.label}>{c.label}</span>
                    <input
                      type="number"
                      className="border rounded px-2 py-1 w-16 min-w-[3.5rem] text-right bg-white dark:bg-gray-800"
                      value={(draftStudent.criteria?.[c.label] ?? 0)}
                      onChange={e=>{
                        const val = e.target.value
                        setDraftStudent(ds=>({
                          ...ds,
                          criteria: { ...(ds.criteria||{}), [c.label]: val }
                        }))
                      }}
                      onBlur={e=>{
                        const val = e.target.value
                        setDraftStudent(ds=>({
                          ...ds,
                          criteria: { ...(ds.criteria||{}), [c.label]: val==='' ? 0 : Number(val) }
                        }))
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                className="px-3 py-2 rounded border"
                onClick={()=>{ setShowAdd(false); setDraftStudent(null) }}
              >
                Cancel
              </button>
              <button
                className="px-3 py-2 rounded bg-emerald-600 text-white"
                onClick={submitAddStudent}
              >
                Add Student
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Footer / version */}
      <div className="max-w-9xl mx-auto px-6 mt-6 pb-10 text-xs text-gray-600 dark:text-gray-300 no-print">
        <div className="flex items-center justify-between">
          <div>
            CSV headers: <code>First Name, Last Name, gender, tags, notes, Previous Teacher</code> + any numeric criteria
            (e.g., <code>Reading,Math,Behavior</code>).
            Tags in CSV may use <code>,</code>, <code>;</code>, <code>/</code>, or <code>|</code>.
          </div>
          <div className="shrink-0 ml-4">
            <span className="px-2 py-0.5 rounded-full border text-gray-600 dark:text-gray-300">
              {VERSION}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
