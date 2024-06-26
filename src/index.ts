import { CodegenGeneratorConstructor, CodegenGeneratorType, CodegenOperation, isCodegenEnumSchema, isCodegenObjectSchema, isCodegenAnyOfSchema, isCodegenInterfaceSchema, isCodegenOneOfSchema, CodegenSchemaType, CodegenMediaType, CodegenContent, CodegenSchemaPurpose, isCodegenArraySchema, CodegenProperties, isCodegenObjectLikeSchema } from '@openapi-generator-plus/types'
import { valueSchemaForMetadataSchema } from '@openapi-generator-plus/utils'
import path from 'path'
import { loadTemplates, emit } from '@openapi-generator-plus/handlebars-templates'
import typescriptGenerator, { options as typescriptCommonOptions, TypeScriptGeneratorContext, chainTypeScriptGeneratorContext, DateApproach } from '@openapi-generator-plus/typescript-generator-common'
import * as idx from '@openapi-generator-plus/indexed-type'

/**
 * An interface representing properties for uploading files in a multipart/form-data request.
 */
interface FileUploadProperty {
	/** Name of the file upload property. */
	name: string
	/** Minimum number of files required if the property takes an array of files. */
	minCount: number | null
	/** Maximum number of files required if the property takes an array of files. */
	maxCount: number | null
	/** Is the file upload property an array of files? */
	isArray: boolean
}

const createGenerator: CodegenGeneratorConstructor = (config, context) => {
	const myContext: TypeScriptGeneratorContext = chainTypeScriptGeneratorContext(context, {
		loadAdditionalTemplates: async(hbs) => {
			await loadTemplates(path.resolve(__dirname, '../templates'), hbs)
		},
		additionalWatchPaths: () => {
			return [path.resolve(__dirname, '../templates')]
		},
		defaultNpmOptions: () => ({
			name: 'typescript-express-passport-server',
			version: '0.0.1',
			private: true,
			repository: null,
		}),
		defaultTypeScriptOptions: () => ({
			target: 'ES2015',
			libs: ['$target', 'DOM'],
		}),
	})

	const generatorOptions = typescriptCommonOptions(config, myContext)

	myContext.additionalExportTemplates = async(outputPath, doc, hbs, rootContext) => {
		/* Convert path template from OpenAPI to Express */
		hbs.registerHelper('pathTemplate', function(value: string) {
			return value.replace(/{(.*?)}/g, ':$1')
		})

		hbs.registerHelper('mediaType', function(value: CodegenMediaType): string {
			return `\`${value.mediaType.replace(/\*/g, '${string}')}\``
		})

		hbs.registerHelper('isJson', function(value: CodegenContent): boolean {
			return !!value.mediaType.mimeType.match('\\bjson$')
		})

		hbs.registerHelper('operationSupportingMultipart', function(value: CodegenOperation): boolean {
			return containsMultipartOperation([value])
		})

		hbs.registerHelper('fileUploadProperties', function(properties: CodegenProperties): FileUploadProperty[] {
			const results: FileUploadProperty[] = []
			for (const prop in properties) {
				const property = properties[prop]

				if (property.schema.purpose !== CodegenSchemaPurpose.METADATA) {
					continue
				}

				const valueSchema = valueSchemaForMetadataSchema(property.schema)

				if (isCodegenObjectLikeSchema(property.schema) && valueSchema?.schemaType === CodegenSchemaType.FILE) {
					results.push({
						name: prop,
						minCount: null,
						maxCount: 1,
						isArray: false,
					})
				} else if (isCodegenArraySchema(property.schema) && valueSchema?.schemaType === CodegenSchemaType.FILE) {
					results.push({
						name: prop,
						minCount: property.schema.minItems,
						maxCount: property.schema.maxItems,
						isArray: true,
					})
				}
			}

			return results
		})

		const relativeSourceOutputPath = generatorOptions.relativeSourceOutputPath
		for (const group of doc.groups) {
			const operations = group.operations
			if (!operations.length) {
				continue
			}

			const apiContainsMultipartOperations = containsMultipartOperation(operations)

			await emit('api', path.join(outputPath, relativeSourceOutputPath, 'api', context.generator().toIdentifier(group.name), 'index.ts'), 
				{ ...rootContext, ...group, ...doc, containsMultipartOperation: apiContainsMultipartOperations }, true, hbs)
			await emit('apiTypes', path.join(outputPath, relativeSourceOutputPath, 'api', context.generator().toIdentifier(group.name), 'types.ts'), 
				{ ...rootContext, ...group, ...doc }, true, hbs)
			await emit('apiReadme', path.join(outputPath, relativeSourceOutputPath, 'api', context.generator().toIdentifier(group.name), 'README.md'), 
				{ ...rootContext, ...group, ...doc }, true, hbs)

			await emit('apiImpl', path.join(outputPath, relativeSourceOutputPath, 'impl', `${context.generator().toIdentifier(group.name)}.ts`), 
				{ ...rootContext, ...group, ...doc, containsMultipartOperation: apiContainsMultipartOperations }, false, hbs)

			if (apiContainsMultipartOperations) {
				await emit('apiMultipartHelper', path.join(outputPath, relativeSourceOutputPath, 'impl/helpers', `${context.generator().toIdentifier(group.name)}MultipartHelper.ts`),
					{ ...rootContext, ...group, ...doc }, false, hbs)
			}
		}

		await emit('models', path.join(outputPath, relativeSourceOutputPath, 'models.ts'), {
			...rootContext,
			...doc,
			schemas: idx.filter(doc.schemas, schema => isCodegenObjectSchema(schema) || isCodegenEnumSchema(schema) || isCodegenOneOfSchema(schema) || isCodegenAnyOfSchema(schema) || isCodegenInterfaceSchema(schema)),
		}, true, hbs)
		await emit('validation', path.join(outputPath, relativeSourceOutputPath, 'validation.ts'), { ...rootContext, ...doc }, true, hbs)
		await emit('index', path.join(outputPath, relativeSourceOutputPath, 'index.ts'), { ...rootContext, ...doc }, true, hbs)
		await emit('indexTypes', path.join(outputPath, relativeSourceOutputPath, 'types.ts'), { ...rootContext, ...doc }, true, hbs)
	}

	const base = typescriptGenerator(config, myContext)

	return {
		...base,
		templateRootContext: () => {
			return {
				...base.templateRootContext(),
				...generatorOptions,
				generatorClass: '@openapi-generator-plus/typescript-express-passport-server-generator',
			}
		},
		postProcessDocument: (doc, helper) => {
			/* Sort operations according to the order we need to declare them */
			doc.groups.forEach(group => {
				group.operations.sort(compareOperations)
			})

			if (base.postProcessDocument) {
				base.postProcessDocument(doc, helper)
			}
		},
		postProcessSchema: (model, helper) => {
			if (base.postProcessSchema) {
				// HACK: we call the base but _don't_ return its value so we don't remove oneOf and anyOf
				// as we still need to generate validations for them
				base.postProcessSchema(model, helper)
			}
		},
		generatorType: () => CodegenGeneratorType.SERVER,
		cleanPathPatterns: () => {
			const result = base.cleanPathPatterns() || []
			const relativeSourceOutputPath = generatorOptions.relativeSourceOutputPath
			result.push(path.join(relativeSourceOutputPath, 'api', '**'))
			return result
		},
		toNativeType: (options) => {
			const { schemaType } = options
			if (schemaType === CodegenSchemaType.DATETIME && generatorOptions.dateApproach === DateApproach.Native) {
				// TODO we need to override the default date type in typescript-generator-common which has a serialized type of string
				return new context.NativeType('Date')
			} else if (schemaType === CodegenSchemaType.FILE) {
				return new context.NativeType('Express.Multer.File')
			} else if (schemaType === CodegenSchemaType.BINARY) {
				return new context.NativeType('string | Buffer')
			} else {
				return base.toNativeType(options)
			}
		},
	}
}

/**
 * Compare CodegenOperations so that they are sorted with the most specific paths first,
 * in order to register them in the necessary order with Express.
 * @param a 
 * @param b 
 */
function compareOperations(a: CodegenOperation, b: CodegenOperation): number {
	const aComponents = a.path.split('/')
	const bComponents = b.path.split('/')

	for (let i = 0; i < aComponents.length; i++) {
		if (i >= bComponents.length) {
			return 1
		}
		const aIsVar = aComponents[i].startsWith('{')
		const bIsVar = bComponents[i].startsWith('{')
		if (aIsVar && !bIsVar) {
			return 1
		} else if (!aIsVar && bIsVar) {
			return -1
		}

		const compared = aComponents[i].localeCompare(bComponents[i])
		if (compared !== 0) {
			return compared
		}
	}

	if (bComponents.length > aComponents.length) {
		return -1
	}
	return 0
}

/**
 * Loop over an array of CodegenOperation and return true if it contains an operation with a multipart/form-data request.
 * @param operations
 */
function containsMultipartOperation(operations: CodegenOperation[]): boolean {
	for (const operation of operations) {
		if (operation.requestBody?.defaultContent.mediaType.mimeType.match('^multipart/.*')) {
			return true
		}
	}
	return false
}

export default createGenerator
