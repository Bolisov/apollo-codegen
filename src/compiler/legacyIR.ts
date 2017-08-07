import { GraphQLSchema, GraphQLType, GraphQLObjectType, GraphQLCompositeType, DocumentNode } from 'graphql';

import {
  compileToIR,
  CompilationContext as NewCompilationContext,
  SelectionSet,
  Field as NewField,
  FragmentSpread
} from './';

import { mergeInFragmentSpreads } from './visitors/mergeInFragmentSpreads';
import { collectFragmentsReferenced } from './visitors/collectFragmentsReferenced';

import { TypeCase } from './flattenIR';

import '../utilities/array';
import { createHash } from 'crypto';

export interface CompilerOptions {
  addTypename?: boolean;
  mergeInFieldsFromFragmentSpreads?: boolean;
  passthroughCustomScalars?: boolean;
  customScalarsPrefix?: string;
  namespace?: string;
  generateOperationIds?: boolean;
}

export interface CompilationContext {
  schema: GraphQLSchema;
  operations: { [operationName: string]: CompiledOperation };
  fragments: { [fragmentName: string]: CompiledFragment };
  typesUsed: GraphQLType[];
  options: CompilerOptions;
}

export interface CompiledOperation {
  filePath?: string;
  operationName: string;
  operationId?: string;
  operationType: string;
  rootType: GraphQLObjectType;
  variables: {
    name: string;
    type: GraphQLType;
  }[];
  source: string;
  sourceWithFragments?: string;
  fields: Field[];
  fragmentSpreads?: string[];
  inlineFragments?: CompiledInlineFragment[];
  fragmentsReferenced: string[];
}

export interface CompiledFragment {
  filePath?: string;
  fragmentName: string;
  source: string;
  typeCondition: GraphQLCompositeType;
  possibleTypes: GraphQLObjectType[];
  fields: Field[];
  fragmentSpreads: string[];
  inlineFragments: any[];
}

export interface CompiledInlineFragment {
  typeCondition: GraphQLObjectType;
  possibleTypes: GraphQLObjectType[];
  fields: Field[];
  fragmentSpreads: string[];
}

export interface Field {
  responseName: string;
  fieldName: string;
  args?: Argument[];
  type: GraphQLType;
  description?: string;
  isConditional?: boolean;
  isDeprecated?: boolean;
  deprecationReason?: string;
  fields?: Field[];
  fragmentSpreads?: string[];
  inlineFragments?: CompiledInlineFragment[];
}

export interface Argument {
  name: string;
  value: any;
}

export function compileToLegacyIR(
  schema: GraphQLSchema,
  document: DocumentNode,
  options: CompilerOptions = { mergeInFieldsFromFragmentSpreads: true }
): CompilationContext {
  const context = compileToIR(schema, document, options);

  const operations: { [operationName: string]: CompiledOperation } = Object.create({});

  for (const [operationName, operation] of Object.entries(context.operations)) {
    const { filePath, operationType, rootType, variables, source, selectionSet } = operation;
    const fragmentsReferenced = Array.from(collectFragmentsReferenced(context, selectionSet));

    const sourceWithFragments = [
      operation.source,
      ...fragmentsReferenced.map(fragmentName => {
        return context.fragments[fragmentName].source;
      })
    ].join('\n');

    const hash = createHash('sha256');
    hash.update(sourceWithFragments);
    const operationId = hash.digest('hex');

    operations[operationName] = {
      filePath,
      operationName,
      operationType,
      rootType,
      variables,
      source,
      ...transformSelectionSetToLegacyIR(context, selectionSet),
      fragmentsReferenced,
      sourceWithFragments,
      operationId
    };
  }

  const fragments: { [fragmentName: string]: CompiledFragment } = Object.create({});

  for (const [fragmentName, fragment] of Object.entries(context.fragments)) {
    const { selectionSet, type, ...fragmentWithoutSelectionSet } = fragment;
    fragments[fragmentName] = {
      typeCondition: type,
      possibleTypes: selectionSet.possibleTypes,
      ...fragmentWithoutSelectionSet,
      ...transformSelectionSetToLegacyIR(context, selectionSet)
    };
  }

  const legacyContext: CompilationContext = {
    schema: context.schema,
    operations,
    fragments,
    typesUsed: context.typesUsed,
    options
  };

  return legacyContext;
}

function transformSelectionSetToLegacyIR(context: NewCompilationContext, selectionSet: SelectionSet) {
  const typeCase = new TypeCase(
    context.options.mergeInFieldsFromFragmentSpreads
      ? mergeInFragmentSpreads(context, selectionSet)
      : selectionSet
  );

  const fields: Field[] = transformFieldsToLegacyIR(context, typeCase.default.fields);

  const inlineFragments: CompiledInlineFragment[] = typeCase.records
    .filter(
      record =>
        // Filter out records that represent the same possible types as the default record.
        !selectionSet.possibleTypes.every(type => record.possibleTypes.includes(type)) &&
        // Filter out empty records for consistency with legacy compiler.
        record.fieldMap.size > 0
    )
    .flatMap(record => {
      const fields = transformFieldsToLegacyIR(context, record.fields);
      const fragmentSpreads: string[] = collectFragmentSpreads(
        context,
        selectionSet,
        record.possibleTypes
      ).map((fragmentSpread: FragmentSpread) => fragmentSpread.fragmentName);
      return record.possibleTypes.map(possibleType => {
        return {
          typeCondition: possibleType,
          possibleTypes: [possibleType],
          fields,
          fragmentSpreads
        } as CompiledInlineFragment;
      });
    });

  for (const inlineFragment of inlineFragments) {
    inlineFragments[inlineFragment.typeCondition.name as any] = inlineFragment;
  }

  const fragmentSpreads: string[] = collectFragmentSpreads(context, selectionSet).map(
    (fragmentSpread: FragmentSpread) => fragmentSpread.fragmentName
  );

  return {
    fields,
    fragmentSpreads,
    inlineFragments
  };
}

function transformFieldsToLegacyIR(context: NewCompilationContext, fields: NewField[]) {
  return fields.map(field => {
    const { args, type, isConditional, description, isDeprecated, deprecationReason, selectionSet } = field;
    return {
      responseName: field.alias || field.name,
      fieldName: field.name,
      type,
      args,
      isConditional,
      description,
      isDeprecated,
      deprecationReason,
      ...selectionSet ? transformSelectionSetToLegacyIR(context, selectionSet) : {}
    } as Field;
  });
}

function collectFragmentSpreads(
  context: NewCompilationContext,
  selectionSet: SelectionSet,
  possibleTypes: GraphQLObjectType[] = selectionSet.possibleTypes
): FragmentSpread[] {
  const fragmentSpreads: FragmentSpread[] = [];

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case 'FragmentSpread':
        fragmentSpreads.push(selection);
        break;
      case 'TypeCondition':
        if (possibleTypes.every(type => selection.selectionSet.possibleTypes.includes(type))) {
          fragmentSpreads.push(...collectFragmentSpreads(context, selection.selectionSet, possibleTypes));
        }
        break;
      case 'BooleanCondition':
        fragmentSpreads.push(...collectFragmentSpreads(context, selection.selectionSet, possibleTypes));
        break;
    }
  }

  return fragmentSpreads;
}
