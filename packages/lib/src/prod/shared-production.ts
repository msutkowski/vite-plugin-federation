import { PluginHooks } from '../../types/pluginHooks'
import {
  findDependencies,
  getModuleMarker,
  isSameFilepath,
  parseOptions
} from '../utils'
import { builderInfo, EXPOSES_MAP, parsedOptions } from '../public'
import { ConfigTypeSet, VitePluginFederationOptions } from 'types'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import * as path from 'path'
import * as fs from 'fs'

const sharedFileReg = /^__federation_shared_.+\.js$/
const pickSharedNameReg = /(?<=^__federation_shared_).+(?=\.js$)/

export function prodSharedPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  parsedOptions.prodShared = parseOptions(
    options.shared || {},
    () => ({
      import: true,
      shareScope: 'default'
    }),
    (value) => {
      value.import = value.import ?? true
      value.shareScope = value.shareScope || 'default'
      return value
    }
  )
  const sharedNames = new Set<string>()
  parsedOptions.prodShared.forEach((value) => sharedNames.add(value[0]))
  const exposesModuleIdSet = new Set()
  EXPOSES_MAP.forEach((value) => {
    exposesModuleIdSet.add(`${value}.js`)
  })
  let isHost
  let isRemote
  const id2Prop = new Map<string, any>()

  return {
    name: 'originjs:shared-production',
    virtualFile: {
      __federation_lib_semver: 'void 0',
      __federation_fn_import: `
      const moduleMap= ${getModuleMarker('moduleMap', 'var')}
      const moduleCache = Object.create(null);
      async function importShared(name,shareScope = 'default') {
        return moduleCache[name] ? new Promise((r) => r(moduleCache[name])) : getProviderSharedModule(name, shareScope);
      }
      async function __federation_import(name){
        return import(name);
      }
      async function getProviderSharedModule(name,shareScope) {
        let module = null;
        if (globalThis?.__federation_shared__?.[shareScope]?.[name]) {
          const versionObj = globalThis.__federation_shared__[shareScope][name];
          const versionKey = Object.keys(versionObj)[0];
          const versionValue = Object.values(versionObj)[0];
          if (moduleMap[name]?.requiredVersion) {
            // judge version satisfy
            const semver= await import('__federation_lib_semver');
            const fn = semver.satisfy;
            if (fn(versionKey, moduleMap[name].requiredVersion)) {
               module = await versionValue.metaGet();
            } else {
              console.log(\`provider support \${name}(\${versionKey}) is not satisfied requiredVersion(\${moduleMap[name].requiredVersion})\`)
            }
          } else {
            module = await versionValue.metaGet();
          }
        }
        if(module){
          moduleCache[name] = module;
          return module;
        }else{
          return getConsumerSharedModule(name, shareScope);
        }
      }
      async function getConsumerSharedModule(name , shareScope) {
        if (moduleMap[name]?.import) {
          const module = await moduleMap[name].get()
          moduleCache[name] = module;
          return module;
        } else {
          console.error(\`consumer config import=false,so cant use callback shared module\`)
        }
      }
      export {importShared};
      `
    },
    options(inputOptions) {
      isHost = !!parsedOptions.prodRemote.length
      isRemote = !!parsedOptions.prodExpose.length

      if (sharedNames.size) {
        // remove item which is both in external and shared
        inputOptions.external = (inputOptions.external as [])?.filter(
          (item) => {
            return !sharedNames.has(item)
          }
        )
      }
      return inputOptions
    },

    async buildStart() {
      // forEach and collect dir
      const collectDirFn = (filePath: string, collect: string[]) => {
        const files = fs.readdirSync(filePath)
        files.forEach((name) => {
          const tempPath = path.join(filePath, name)
          const isDir = fs.statSync(tempPath).isDirectory()
          if (isDir) {
            collect.push(tempPath)
            collectDirFn(tempPath, collect)
          }
        })
      }

      const monoRepos: { arr: string[]; root: string | ConfigTypeSet }[] = []
      const dirPaths: string[] = []
      const currentDir = path.resolve()
      for (const arr of parsedOptions.prodShared) {
        try {
          const resolve = await this.resolve(arr[0])
          arr[1].id = resolve?.id
        } catch (e) {
          //    try to resolve monoRepo
          arr[1].removed = true
          const dir = path.join(currentDir, 'node_modules', arr[0])
          const dirStat = fs.statSync(dir)
          if (dirStat.isDirectory()) {
            collectDirFn(dir, dirPaths)
          } else {
            this.error(`cant resolve "${arr[0]}"`)
          }

          if (dirPaths.length > 0) {
            monoRepos.push({ arr: dirPaths, root: arr })
          }
        }

        if (isHost && !arr[1].version) {
          const packageJsonPath = `${currentDir}${path.sep}node_modules${path.sep}${arr[0]}${path.sep}package.json`
          arr[1].version = (await import(packageJsonPath)).version
          if (!arr[1].version) {
            this.error(
              `No description file or no version in description file (usually package.json) of ${arr[0]}(${packageJsonPath}). Add version to description file, or manually specify version in shared config.`
            )
          }
        }
      }
      parsedOptions.prodShared = parsedOptions.prodShared.filter(
        (item) => !item[1].removed
      )
      // assign version to monoRepo
      if (monoRepos.length > 0) {
        for (const monoRepo of monoRepos) {
          for (const id of monoRepo.arr) {
            try {
              const idResolve = await this.resolve(id)
              if (idResolve?.id) {
                (parsedOptions.prodShared as any[]).push([
                  `${monoRepo.root[0]}/${path.basename(id)}`,
                  {
                    id: idResolve?.id,
                    import: monoRepo.root[1].import,
                    shareScope: monoRepo.root[1].shareScope,
                    root: monoRepo.root
                  }
                ])
              }
            } catch (e) {
              //    ignore
            }
          }
        }
      }
      // console.log(parsedOptions.prodShared);

      if (parsedOptions.prodShared.length && isRemote) {
        for (const prod of parsedOptions.prodShared) {
          id2Prop.set(prod[1].id, prod[1])
        }
        this.emitFile({
          fileName: `${
            builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
          }__federation_fn_import.js`,
          type: 'chunk',
          id: '__federation_fn_import',
          preserveSignature: 'strict'
        })
        this.emitFile({
          fileName: `${
            builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
          }__federation_lib_semver.js`,
          type: 'chunk',
          id: '__federation_lib_semver',
          preserveSignature: 'strict'
        })
      }
    },
    outputOptions: function (outputOption) {
      // remove rollup generated empty imports,like import './filename.js'
      outputOption.hoistTransitiveImports = false

      // sort shared dep
      const that = this
      const priority: string[] = []
      const depInShared = new Map()
      parsedOptions.prodShared.forEach((value) => {
        const shareName = value[0]
        // pick every shared moduleId
        const usedSharedModuleIds = new Set<string>()
        const sharedModuleIds = new Map<string, string>()
        // exclude itself
        parsedOptions.prodShared
          .filter((item) => item[0] !== shareName)
          .forEach((item) => sharedModuleIds.set(item[1].id, item[0]))
        depInShared.set(shareName, usedSharedModuleIds)
        const deps = new Set<string>()
        findDependencies.apply(that, [
          value[1].id,
          deps,
          sharedModuleIds,
          usedSharedModuleIds
        ])
        value[1].dependencies = deps
      })
      // judge dependencies priority
      const orderByDepCount: Map<string, Set<string>>[] = []
      depInShared.forEach((value, key) => {
        if (!orderByDepCount[value.size]) {
          orderByDepCount[value.size] = new Map()
        }
        orderByDepCount[value.size].set(key, value)
      })

      // dependency nothing is first,handle index = 0
      if (orderByDepCount[0]) {
        for (const key of orderByDepCount[0].keys()) {
          priority.push(key)
        }
      }

      // handle index >= 1
      orderByDepCount
        .filter((item, index) => item && index >= 1)
        .forEach((item) => {
          for (const entry of item.entries()) {
            addDep(entry, priority, depInShared)
          }
        })

      function addDep([key, value], priority, depInShared) {
        for (const dep of value) {
          if (!priority.includes(dep)) {
            addDep([dep, depInShared.get(dep)], priority, depInShared)
          }
        }
        if (!priority.includes(key)) {
          priority.push(key)
        }
      }

      // adjust the map order according to priority
      parsedOptions.prodShared.sort((a, b) => {
        const aIndex = priority.findIndex((value) => value === a[0])
        const bIndex = priority.findIndex((value) => value === b[0])
        return aIndex - bIndex
      })
      // only active when manualChunks is function,array not to solve
      if (typeof outputOption.manualChunks === 'function') {
        outputOption.manualChunks = new Proxy(outputOption.manualChunks, {
          apply(target, thisArg, argArray) {
            const id = argArray[0]
            //  if id is in shared dependencies, return id ,else return vite function value
            const find = parsedOptions.prodShared.find((arr) =>
              arr[1].dependencies.has(id)
            )
            return find ? find[0] : target(argArray[0], argArray[1])
          }
        })
      }
      return outputOption
    },
    renderChunk: function (code, chunk, options) {
      //   process shared chunk
      const sharedFlag = sharedFileReg.test(path.basename(chunk.fileName))
      const facadeModuleId = chunk.facadeModuleId
      const exposesFlag = parsedOptions.prodExpose.some((expose) =>
        isSameFilepath(expose[1].id, facadeModuleId as string)
      )
      const needSharedImport =
        isRemote &&
        parsedOptions.prodShared.length > 0 &&
        chunk.type === 'chunk' &&
        (sharedFlag || exposesFlag) &&
        chunk.imports.some((importName) =>
          sharedFileReg.test(path.basename(importName))
        )
      if (needSharedImport) {
        const ast = this.parse(code)
        const magicString = new MagicString(code)
        let modify = false
        switch (options.format) {
          case 'es':
            {
              walk(ast, {
                enter(node: any) {
                  if (
                    node.type === 'ImportDeclaration' &&
                    sharedFileReg.test(path.basename(node.source.value))
                  ) {
                    const sharedName = path
                      .basename(node.source.value)
                      .match(pickSharedNameReg)?.[0]
                    if (sharedName) {
                      const declaration: (string | never)[] = []
                      node.specifiers?.forEach((specify) => {
                        declaration.push(
                          `${
                            specify.imported?.name
                              ? `${
                                  specify.imported.name === specify.local.name
                                    ? specify.local.name
                                    : `${specify.imported.name}:${specify.local.name}`
                                }`
                              : `default:${specify.local.name}`
                          }`
                        )
                      })
                      if (declaration.length) {
                        magicString.overwrite(
                          node.start,
                          node.end,
                          `const {${declaration.join(
                            ','
                          )}} = await importShared('${sharedName}')`
                        )
                        modify = true
                      }
                    }
                  }
                }
              })
              if (modify) {
                const prop = id2Prop.get(facadeModuleId as string)
                magicString.prepend(
                  `import {importShared} from '${
                    prop?.root ? '.' : ''
                  }./__federation_fn_import.js'\n`
                )
                return magicString.toString()
              }
            }
            break
          case 'system':
            {
              walk(ast, {
                enter(node: any) {
                  const expression =
                    node.body.length === 1
                      ? node.body[0]?.expression
                      : node.body.find(
                          (item) =>
                            item.type === 'ExpressionStatement' &&
                            item.expression?.callee?.object?.name ===
                              'System' &&
                            item.expression.callee.property?.name === 'register'
                        )?.expression
                  if (expression) {
                    const args = expression.arguments
                    if (
                      args[0].type === 'ArrayExpression' &&
                      args[0].elements?.length > 0
                    ) {
                      const importIndex: any[] = []
                      let removeLast = false
                      chunk.imports.forEach((importName, index) => {
                        const baseName = path.basename(importName)
                        if (sharedFileReg.test(baseName)) {
                          importIndex.push({
                            index: index,
                            name: baseName.match(pickSharedNameReg)?.[0]
                          })
                          if (index === chunk.imports.length - 1) {
                            removeLast = true
                          }
                        }
                      })
                      if (
                        importIndex.length &&
                        args[1]?.type === 'FunctionExpression'
                      ) {
                        const functionExpression = args[1]
                        const returnStatement =
                          functionExpression?.body?.body.find(
                            (item) => item.type === 'ReturnStatement'
                          )
                        // insert __federation_import variable
                        magicString.prependLeft(
                          returnStatement.start,
                          'var __federation_import;\n'
                        )
                        const setters =
                          returnStatement.argument.properties.find(
                            (property) => property.key.name === 'setters'
                          )
                        const settersElements = setters.value.elements
                        // insert __federation_import setter
                        magicString.appendRight(
                          setters.end - 1,
                          `${
                            removeLast ? '' : ','
                          }function (module){__federation_import=module.importShared}`
                        )
                        const execute =
                          returnStatement.argument.properties.find(
                            (property) => property.key.name === 'execute'
                          )
                        const insertPos = execute.value.body.body[0].start
                        importIndex.forEach((item) => {
                          // remove unnecessary setters and import
                          const last = item.index === settersElements.length - 1
                          magicString.remove(
                            settersElements[item.index].start,
                            last
                              ? settersElements[item.index].end
                              : settersElements[item.index + 1].start - 1
                          )
                          magicString.remove(
                            args[0].elements[item.index].start,
                            last
                              ? args[0].elements[item.index].end
                              : args[0].elements[item.index + 1].start - 1
                          )
                          // insert federation shared import lib
                          const varName = `__federation_${item.name}`
                          magicString.prependLeft(
                            insertPos,
                            `var  ${varName} = await __federation_import('${item.name}');\n`
                          )
                          // replace it with sharedImport
                          setters.value.elements[item.index].body.body.forEach(
                            (setFn) => {
                              magicString.appendLeft(
                                insertPos,
                                `${setFn.expression.left.name} = ${varName}.${
                                  setFn.expression.right.property.name ??
                                  setFn.expression.right.property.value
                                };\n`
                              )
                            }
                          )
                        })
                        // add async flag to execute function
                        magicString.prependLeft(execute.value.start, ' async ')
                        // add sharedImport import declaration
                        magicString.appendRight(
                          args[0].end - 1,
                          `${
                            removeLast ? '' : ','
                          }'./__federation_fn_import.js'`
                        )
                        modify = true
                      }
                    }
                  }
                  // only need to process once
                  this.skip()
                }
              })
              if (modify) {
                return magicString.toString()
              }
            }
            break
        }
      }
      return null
    }
  }
}
