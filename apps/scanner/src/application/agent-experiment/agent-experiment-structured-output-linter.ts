import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { KeywordClassification, StructuredOutputKeywordOccurrence, StructuredOutputLintReport,
  StructuredOutputMetrics, StructuredOutputProbe, StructuredOutputViolation } from './agent-experiment-structured-output.types';

type JsonObject = Record<string, unknown>;
const SUPPORTED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', '$ref', '$defs', 'anyOf']);
const FORBIDDEN = new Set(['prefixItems', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'contains', 'minContains', 'maxContains',
  'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'dependentRequired', 'dependentSchemas', 'nullable',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$schema', '$id']);
const PROJECT_AWAY = new Set(['format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems',
  'uniqueItems', 'minProperties', 'maxProperties']);
const ANNOTATIONS = new Set(['title', 'description']);

export function inspectStructuredOutputSchema(schema: unknown): StructuredOutputLintReport {
  const inventory: StructuredOutputKeywordOccurrence[] = [], violations: StructuredOutputViolation[] = [];
  const metrics: StructuredOutputMetrics = { schemaBytes: Buffer.byteLength(JSON.stringify(schema)), maximumNestingDepth: 0,
    totalPropertyCount: 0, totalRequiredEntryCount: 0, totalEnumValueCount: 0, totalEnumStringBytes: 0,
    totalIdentifierAndEnumStringBytes: 0, objectNodeCount: 0, arrayNodeCount: 0, anyOfNodeCount: 0, nullablePropertyCount: 0 };
  const refs = new Set<string>();
  walk(schema, '$', 1, true);
  for (const ref of refs) if (!resolveLocalRef(schema, ref)) violation('$', '$ref', ref, 'CONFIRMED_STATIC_VIOLATION', 'LOCAL_REF_MUST_RESOLVE',
    'Reference an existing local $defs node', 'AJV and the existing parser continue structural validation');
  if (metrics.maximumNestingDepth > 10) violation('$', 'depth', metrics.maximumNestingDepth, 'CONFIRMED_STATIC_VIOLATION', 'MAX_DEPTH_10', 'Reduce schema nesting', 'Existing parser retains semantic nesting checks');
  if (metrics.totalPropertyCount > 5000) violation('$', 'properties', metrics.totalPropertyCount, 'CONFIRMED_STATIC_VIOLATION', 'MAX_PROPERTIES_5000', 'Reduce properties', 'Existing parser retains domain validation');
  if (metrics.totalEnumValueCount > 1000) violation('$', 'enum', metrics.totalEnumValueCount, 'CONFIRMED_STATIC_VIOLATION', 'MAX_ENUM_VALUES_1000', 'Reduce enum values', 'Existing parser retains enum validation');
  if (metrics.totalIdentifierAndEnumStringBytes > 120000) violation('$', 'stringBudget', metrics.totalIdentifierAndEnumStringBytes, 'CONFIRMED_STATIC_VIOLATION', 'MAX_IDENTIFIER_ENUM_BYTES_120000', 'Reduce identifiers/enums', 'Existing parser retains values');
  inventory.sort(compare); violations.sort(compare);
  return { validForConfiguredSubset: violations.length === 0, metrics, keywordInventory: inventory, violations };

  function walk(value: unknown, path: string, depth: number, root = false): void {
    if (!isObject(value)) return;
    metrics.maximumNestingDepth = Math.max(metrics.maximumNestingDepth, depth);
    const nodeType = schemaType(value);
    if (root) {
      if (value.type !== 'object') violation(path, 'type', value.type, 'CONFIRMED_STATIC_VIOLATION', 'ROOT_TYPE_OBJECT', 'Set type to object', 'Root object remains the transport envelope');
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'not']) if (keyword in value) violation(path, keyword, value[keyword], 'CONFIRMED_STATIC_VIOLATION', 'ROOT_COMPOSITION_FORBIDDEN', 'Use one closed object', 'Branch validator enforces status semantics');
    }
    for (const [keyword, item] of Object.entries(value)) {
      const classification = classify(keyword, item);
      inventory.push({ jsonPath: `${path}.${keyword}`, keyword, valueType: valueType(item), schemaNodeType: nodeType, classification: classification[0], reason: classification[1] });
      if (FORBIDDEN.has(keyword)) violation(path, keyword, item, 'CONFIRMED_STATIC_VIOLATION', 'KEYWORD_FORBIDDEN', projection(keyword), semantic(keyword));
      else if (PROJECT_AWAY.has(keyword)) violation(path, keyword, item, 'LIKELY_PROVIDER_INCOMPATIBILITY', 'PROJECT_SEMANTIC_CONSTRAINT', `Remove ${keyword} from API-facing schema`, semantic(keyword));
      else if (keyword === 'const') violation(path, keyword, item, 'ALLOWED_BUT_NON_CANONICAL', 'CONST_TO_ENUM', `Use enum: [${JSON.stringify(item)}]`, 'Existing parser enforces the literal');
      else if (keyword === 'type' && Array.isArray(item)) violation(path, keyword, item, 'CONFIRMED_STATIC_VIOLATION', 'TYPE_ARRAY_FORBIDDEN_BY_CONFIGURED_SUBSET', 'Use anyOf with one non-null schema and {type:"null"}', 'Existing parser and branch validator enforce non-null semantics');
      else if (keyword === '$ref' && typeof item === 'string') {
        if (!item.startsWith('#/$defs/')) violation(path, keyword, item, 'CONFIRMED_STATIC_VIOLATION', 'EXTERNAL_REF_FORBIDDEN', 'Use a local $defs reference or inline schema', 'Existing parser retains validation');
        else refs.add(item);
      }
    }
    if (value.type === 'object') {
      metrics.objectNodeCount++;
      const properties = isObject(value.properties) ? value.properties : null;
      const required = Array.isArray(value.required) ? value.required : null;
      if (value.additionalProperties !== false) violation(path, 'additionalProperties', value.additionalProperties, 'CONFIRMED_STATIC_VIOLATION', 'OBJECT_MUST_BE_CLOSED', 'Set additionalProperties:false', 'Existing strict parser also rejects unknown keys');
      if (!properties) violation(path, 'properties', value.properties, 'CONFIRMED_STATIC_VIOLATION', 'OBJECT_PROPERTIES_REQUIRED', 'Define properties', 'Existing parser defines object fields');
      if (!required) violation(path, 'required', value.required, 'CONFIRMED_STATIC_VIOLATION', 'OBJECT_REQUIRED_REQUIRED', 'Require every property', 'Nullable anyOf represents optional fields');
      if (properties) {
        const keys = Object.keys(properties); metrics.totalPropertyCount += keys.length; metrics.totalIdentifierAndEnumStringBytes += keys.reduce((n, key) => n + Buffer.byteLength(key), 0);
        if (required) {
          metrics.totalRequiredEntryCount += required.length;
          const missing = keys.filter((key) => !required.includes(key)), extra = required.filter((key) => typeof key !== 'string' || !keys.includes(key));
          if (missing.length || extra.length) violation(path, 'required', required, 'CONFIRMED_STATIC_VIOLATION', 'ALL_PROPERTIES_REQUIRED', `Require exactly: ${keys.join(',')}`, 'Optional values use canonical anyOf null');
        }
        for (const [name, child] of Object.entries(properties)) { if (isNullable(child)) metrics.nullablePropertyCount++; walk(child, `${path}.properties.${escapePath(name)}`, depth + 1); }
      }
    }
    if (value.type === 'array') { metrics.arrayNodeCount++; if (!isObject(value.items)) violation(path, 'items', value.items, 'CONFIRMED_STATIC_VIOLATION', 'ARRAY_SINGLE_ITEMS_SCHEMA', 'Provide one items schema', 'Existing parser enforces tuple length where needed'); else walk(value.items, `${path}.items`, depth + 1); }
    if (Array.isArray(value.enum)) { metrics.totalEnumValueCount += value.enum.length; for (const entry of value.enum) if (typeof entry === 'string') { const bytes=Buffer.byteLength(entry); metrics.totalEnumStringBytes+=bytes;metrics.totalIdentifierAndEnumStringBytes+=bytes; } }
    if (Array.isArray(value.anyOf)) { metrics.anyOfNodeCount++; value.anyOf.forEach((child, index) => { if (!isObject(child)) violation(`${path}.anyOf[${index}]`, 'anyOf', child, 'CONFIRMED_STATIC_VIOLATION', 'ANYOF_BRANCH_SCHEMA_REQUIRED', 'Use a valid schema object', 'Existing parser enforces the union'); else walk(child, `${path}.anyOf[${index}]`, depth + 1); }); }
    if (isObject(value.$defs)) for (const [name, child] of Object.entries(value.$defs)) { metrics.totalIdentifierAndEnumStringBytes += Buffer.byteLength(name); walk(child, `${path}.$defs.${escapePath(name)}`, depth + 1); }
  }
  function violation(jsonPath:string, keyword:string, currentValue:unknown, severity:StructuredOutputViolation['severity'], rule:string, proposedProjection:string, semanticEnforcementAfterProjection:string):void { violations.push({severity,jsonPath:`${jsonPath}.${keyword}`,keyword,currentValue,rule,proposedProjection,semanticEnforcementAfterProjection}); }
}

export function createStructuredOutputProbePlan(schema: JsonObject): StructuredOutputProbe[] {
  const schemas = createStructuredOutputProbeSchemas(schema);
  const groups = [['requestId'], ['requestId','status'], ['requestId','schemaVersion','status'], ['requestId','schemaVersion','status','summary'],
    ['requestId','schemaVersion','status','summary','assessments'], ['requestId','schemaVersion','status','summary','assessments','requests'], Object.keys(schema.properties as JsonObject)];
  return groups.map((includedTopLevelProperties,index)=>{const serialized=JSON.stringify(schemas[index]);return{probeId:`P${index}`,parentProbeId:index?`P${index-1}`:null,includedTopLevelProperties,schemaSha256:createHash('sha256').update(serialized).digest('hex'),schemaBytes:Buffer.byteLength(serialized),expectedPurpose:['minimal root object','status discriminator','common scalar fields','first nested object group','remaining analysis group','array and request/reference groups','full v1.1.0 schema'][index]!,maxCalls:1};});
}

export function createStructuredOutputProbeSchemas(schema: JsonObject): JsonObject[] {
  const groups = [['requestId'], ['requestId','status'], ['requestId','schemaVersion','status'], ['requestId','schemaVersion','status','summary'],
    ['requestId','schemaVersion','status','summary','assessments'], ['requestId','schemaVersion','status','summary','assessments','requests']];
  return [...groups.map((names)=>projectTop(schema,names)), schema];
}

function projectTop(schema:JsonObject,names:string[]):JsonObject {
  const props=schema.properties as JsonObject, properties=Object.fromEntries(names.map(name=>[name,props[name]]));
  const definitions=schema.$defs as JsonObject, requiredDefinitions=new Set<string>();
  collectRefs(properties);
  const selectedDefinitions:JsonObject={};
  for (const name of requiredDefinitions) selectedDefinitions[name]=definitions[name];
  return {type:'object',additionalProperties:false,required:names,properties,...(requiredDefinitions.size?{$defs:selectedDefinitions}:{})};
  function collectRefs(value:unknown):void {
    if(Array.isArray(value)){value.forEach(collectRefs);return;}if(!isObject(value))return;
    if(typeof value.$ref==='string'&&value.$ref.startsWith('#/$defs/')){const name=value.$ref.slice('#/$defs/'.length);if(!requiredDefinitions.has(name)){requiredDefinitions.add(name);collectRefs(definitions[name]);}}
    for(const item of Object.values(value))collectRefs(item);
  }
}
function classify(keyword:string,value:unknown):[KeywordClassification,string] { if (ANNOTATIONS.has(keyword)) return ['ANNOTATION_ONLY','Descriptive annotation']; if (FORBIDDEN.has(keyword)) return ['UNSUPPORTED','Excluded from configured strict subset']; if (PROJECT_AWAY.has(keyword)) return ['CONDITIONALLY_SUPPORTED','Projected away so the existing parser remains authoritative']; if (keyword==='const'||keyword==='type'&&Array.isArray(value)) return ['CONDITIONALLY_SUPPORTED','Canonical projection required']; if (SUPPORTED.has(keyword)) return ['SUPPORTED','Supported by configured strict subset']; return ['UNKNOWN','Not in configured keyword policy']; }
function projection(keyword:string):string{return keyword==='prefixItems'?'Replace tuple with a homogeneous items schema':`Remove ${keyword} from API-facing schema`;}
function semantic(keyword:string):string{return ['minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems','prefixItems'].includes(keyword)?'Existing Zod parser enforces the constraint':'Existing parser/semantic validator remains authoritative';}
function schemaType(value:JsonObject):string{return Array.isArray(value.type)?value.type.join('|'):typeof value.type==='string'?value.type:value.anyOf?'anyOf':value.$ref?'ref':'unspecified';}
function valueType(value:unknown):string{return Array.isArray(value)?'array':value===null?'null':typeof value;}
function isObject(value:unknown):value is JsonObject{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function isNullable(value:unknown):boolean{return isObject(value)&&Array.isArray(value.anyOf)&&value.anyOf.some(branch=>isObject(branch)&&branch.type==='null');}
function resolveLocalRef(root:unknown,ref:string):unknown{return ref.slice(2).split('/').reduce((current,key)=>isObject(current)?current[key]:undefined,root);}
function escapePath(value:string):string{return value.replaceAll('~','~0').replaceAll('.','\\.');}
function compare(a:{jsonPath:string;keyword:string},b:{jsonPath:string;keyword:string}):number{return a.jsonPath.localeCompare(b.jsonPath)||a.keyword.localeCompare(b.keyword);}
