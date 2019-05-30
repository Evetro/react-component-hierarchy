#!/usr/bin/env node

'use strict'; // eslint-disable-line
const { accessSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');
// const { promisify } = require('util');
const babylon = require('babylon');
const program = require('commander');
/*
const {
  NodeJsInputFileSystem,
  CachedInputFileSystem,
  ResolverFactory
} = require('enhanced-resolve');
*/
const _ = require('lodash');
const tree = require('pretty-tree');

program
  .version('1.1.1')
  .usage('[opts] <path/to/rootComponent>')
  .option('-a, --aliasing  <config>', 'Path to Webpack config for getting module alias definitions')
  .option('-c, --hide-containers', 'Hide redux container components')
  .option('-d, --scan-depth <depth>', 'Limit the depth of the component hierarchy that is displayed', parseInt, Number.POSITIVE_INFINITY)
  .option('-j, --json', 'Output graph to JSON file instead of printing it on screen')
  .option('-m, --module-dir <dir>', 'Path to additional modules not included in node_modules e.g. src')
  .option('-t, --hide-third-party', 'Hide third party components')
  .description('React component hierarchy viewer.')
  .parse(process.argv);

if (!program.args[0]) {
  program.help();
}

const webpackConfigPath = program.aliasing;
const hideContainers = program.hideContainers;
const scanDepth = Math.max(program.scanDepth,1);
const outputJSON = program.json;
const moduleDir = program.moduleDir;
const hideThirdParty = program.hideThirdParty;

const filename = path.resolve(program.args[0]); // root to be input in resolver

const rootNode = {
  name: path.basename(filename).replace(/\.jsx?/, ''),
  filename,
  depth: 0,
  children: [],
};

// Options for module resolver
let alias = [];
// Use directory of root file as part of modules list the resolver will search in when resolving imports
// const modules = [path.dirname(filename), 'node_modules'];

if (typeof webpackConfigPath === 'string' && webpackConfigPath.substring(0, 2) === './' && !(webpackConfigPath.includes('../'))) {
  try {
    const config = require(path.resolve(webpackConfigPath));
    if (config != null && config.resolve != null && config.resolve.alias != null) alias = config.resolve.alias;
  } catch (e) {
    console.error(e.stack);
  }
} else if (webpackConfigPath.substring(0, 2) !== './') {
  console.error('Path given must be relative to the execution environment.');
} else if (confPath.includes('../')) {
  console.error('Backtracking paths are disallowed when specifying Webpack config path.');
}
/*
const moduleResolver = ResolverFactory.createResolver({
  // The `CachedInputFileSystem` simply wraps the Node.js `fs` wrapper to add resilience + caching to `NodeJsInputFileSystem`.
  fileSystem: new CachedInputFileSystem(new NodeJsInputFileSystem(), 4000),
  extensions: ['.js', '.jsx'],
  alias,
  modules,
});

// The resolve function follows the callback-last-with-error-first convention enforced in NodeJS, so this will work
const resolveFilePathAsync = promisify(moduleResolver.resolve).bind(moduleResolver);
*/
function extractModules(bodyItem) {
  if (
    bodyItem.type === 'ImportDeclaration' &&
    !bodyItem.source.value.endsWith('css')
  ) {
    // There may be more than one import in the declaration
    return bodyItem.specifiers.map(specifier => ({
      name: specifier.local.name,
      source: bodyItem.source.value,
    }));
  }
  return null;
}

function extractChildComponents(tokens, imports) {
  const childComponents = [];
  let childComponent;
  for (var i = 0; i < tokens.length - 1; i++) {
    if (
      tokens[i].type.label === 'jsxTagStart' &&
      tokens[i + 1].type.label === 'jsxName'
    ) {
      childComponent = _.find(imports, { name: tokens[i + 1].value });
      if (childComponent) {
        childComponents.push(childComponent);
      }
    } else if (
      tokens[i].type.label === 'jsxName' &&
      tokens[i].value === 'component'
    ) {
      // Find use of components in react-router, e.g. `<Route component={...}>`
      childComponent = _.find(imports, { name: tokens[i + 3].value });
      if (childComponent) {
        childComponents.push(childComponent);
      }
    }
  }
  return childComponents;
}
function resolveAliasedFilePath(node) {
  const [aliasComponent, ...tail] = node.source.split('/'); // We assume here that / is the path separator used in aliased modules in the source code
  // Match file name against aliases
  const value = alias[aliasComponent];
  if (typeof value === 'string') {
    const resolved = value.includes('/') ? value.split('/').join(path.sep) : value;
    const fp = tail.length > 0 ? `${resolved}${path.sep}${tail.join(path.sep)}` : resolved;
    return fp;
  }
  return node.source;
}

function formatChild(child, parent, depth) {
  const dir = path.dirname(parent.filename);
  const filePath = resolveAliasedFilePath(child);
  let filename;
  let source;
  if (child.source.startsWith('.')) {
    // Relative import (./ or ../) - Not an alias
    filename = path.resolve(`${dir}${path.sep}${child.source}`);
    source = filename.replace(`${process.cwd()}${path.sep}`, '');
  } else if (Object.keys(alias).length > 0 && typeof filePath === 'string') {
    filename = filePath;
    source = filename.replace(`${process.cwd()}${path.sep}`, '');
  } else {
    // Third party component
    filename = path.join(dir, child.source);
    source = child.source;
  }
  return { source, name: child.name, filename, children: [], depth };
}

function extractExport(body) {
  let result;
  body.some(b => {
    if (b.type === 'ExportDefaultDeclaration') {
      result = b.declaration.name;
    }
    return result;
  });
  return result;
}

function findImportInArguments(func, imports, importNames) {
  const args = _.get(func, '.arguments', []).map(a => a.name);
  const foundImports = _.intersection(args, importNames);
  return _.get(foundImports, '[0]');
}

function findImportInExportDeclaration(body, exportIdentifier, imports) {
  let result;
  body.some(b => {
    if (
      b.type === 'VariableDeclaration' &&
      b.declarations[0].id.name === exportIdentifier &&
      b.declarations[0].init.type === 'CallExpression'
    ) {
      // If the export is being declared with the result of a function..
      // Try to find a reference to any of the imports either in the function arguments,
      // or in the arguments of any other functions being called after this function
      let func = b.declarations[0].init;
      while (!result && func) {
        result = findImportInArguments(func, imports, imports.map(i => i.name));
        if (!result) {
          func = _.get(func, '.callee');
        }
      }
      if (result) {
        result = _.find(imports, { name: result });
      }
    }
    return result;
  });
  return result;
}

// - Find out what is being exported
// - Look for the export variable declaration
// - Look for any imported identifiers being used as a function parameter
// - Return that as the child
function findContainerChild(node, body, imports, depth) {
  const exportIdentifier = extractExport(body);
  const usedImport = findImportInExportDeclaration(
    body,
    exportIdentifier,
    imports,
  );
  if (usedImport == null) return [];
  return [formatChild(usedImport, node, depth)];
}

/** Processes index file for an aliased module  */
function processIndexFile(node, file) {
  const ast = babylon.parse(file, {
    sourceType: 'module',
    plugins: [
      'asyncGenerators',
      'classProperties',
      'decorators',
      'dynamicImport',
      'exportExtensions',
      'flow',
      'functionBind',
      'functionSent',
      'jsx',
      'objectRestSpread',
    ],
  });
  const imports = ast.program.body.map(extractModules).filter(i => Boolean(i)).reduce((l, i) => l.concat(i), []);
  const match = ({ name }) => name = node.name;
  if (imports.some(match)) {
    const { source } = imports.filter(match).pop();
    console.log(source);
    // Resolve relative source
    const newPath = `${path.dirname(node.filename)}${path.sep}${source.split('/').slice(1).join(path.sep)}`;
    return [`${newPath}.jsx`, `${newPath}.js`];
  }
  return [];
}

function processFile(node, file, depth) {
  /** @warning Do not run this function if you are checking in an index file! **/
  /** code below causes infinte loop! **/
  const ast = babylon.parse(file, {
    sourceType: 'module',
    plugins: [
      'asyncGenerators',
      'classProperties',
      'decorators',
      'dynamicImport',
      'exportExtensions',
      'flow',
      'functionBind',
      'functionSent',
      'jsx',
      'objectRestSpread',
    ],
  });
  // Get a list of imports and try to figure out which are child components
  const imports = ast.program.body.map(extractModules).filter(i => Boolean(i)).reduce((l, i) => l.concat(i), []);
  if (_.find(imports, { name: 'React' })) {
    // Look for children in the JSX
    const childComponents = _.uniq(extractChildComponents(ast.tokens, imports));
    node.children = childComponents.map(c => formatChild(c, node, depth));
  } else {
    // Not JSX... try to search for a wrapped component
    node.children = findContainerChild(node, ast.program.body, imports, depth);
  }
}

function formatNodeToPrettyTree(node) {
  if (hideContainers && node.name.indexOf('Container') > -1) {
    node.children[0].name += ' (*)';
    return formatNodeToPrettyTree(node.children[0]);
  }
  // If we have the source, format it nicely like `module/Component`
  // But only if the name won't be repeated like `module/Component/Component`
  const source =
    path.basename(path.dirname(node.filename)) === node.name
      ? node.source
      : node.source + path.sep + node.name;
  const newNode =
    node.children.length > 0
      ? {
          label: (node.source && source) || node.name,
          nodes: node.children
            .filter(n => !n.hide)
            .sort((a, b) => {
              // Sort the list by source and name for readability
              const nameA = (a.source + a.name).toUpperCase();
              const nameB = (b.source + b.name).toUpperCase();

              if (nameA < nameB) {
                return -1;
              }
              if (nameA > nameB) {
                return 1;
              }

              return 0;
            })
            .map(formatNodeToPrettyTree),
          depth: node.depth,
        }
      : {
          label: source,
          depth: node.depth,
        };

  return newNode;
}

function done() {
  if (!rootNode.children) {
    console.error(
      'Could not find any components. Did you process the right file?'
    );
    process.exit(1);
  }
  if (outputJSON) writeFileSync('data.json', JSON.stringify(rootNode));
  else console.log(tree(formatNodeToPrettyTree(rootNode)));
  process.exit();
}

function processNode(node, depth, parent) {
  const getPossibleNames = baseName => [
    baseName,
    `${baseName}.jsx`,
    `${baseName}.js`,
    `${baseName}${path.sep}index.js`,
    `${baseName}${path.sep}index.jsx`,
  ];
  const possibleFileNames = [];
  if (Object.keys(alias).length > 0 && typeof node.source === 'string') {
    possibleFileNames.push(...getPossibleNames(resolveAliasedFilePath(node)));
  }
  possibleFileNames.push(...getPossibleNames(node.filename));
  if (parent && moduleDir) {
    const moduleName = node.filename.replace(path.dirname(parent.filename), moduleDir);
    possibleFileNames.push(...getPossibleNames(moduleName));
  }
  for (const name of possibleFileNames) {
    if (name.endsWith('index.js') || name.endsWith('index.jsx')) {
      try {
        const f = readFileSync(name, 'utf8');
        for (const newPath of processIndexFile(node, f)) {
          const file = readFileSync(newPath, 'utf8');
          if (depth <= scanDepth) {
            processFile(node, file, depth);
          }
          node.children.forEach(c => processNode(c, depth + 1, node));
          return;
        }
      } catch(e) { console.log(e.message); }
    }
    node.filename = name;
    try {
      const file = readFileSync(node.filename, 'utf8');
      if (depth <= scanDepth) {
        processFile(node, file, depth);
      }
      node.children.forEach(c => processNode(c, depth + 1, node));
      return;
    } catch (e) {}
  }
  if (hideThirdParty) {
    node.hide = true;
  }
}

processNode(rootNode, 1);
done();
