#!/usr/bin/env node

/* eslint-disable no-console */
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');
const babylon = require('babylon');
const program = require('commander');
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
const { hideContainers, hideThirdParty, moduleDir } = program;
const scanDepth = Math.max(program.scanDepth, 1);
const outputJSON = program.json;

const filename = path.resolve(program.args[0]); // root to be input in resolver
const rootFolder = path.dirname(filename); // The catalog in which the provided root file lies
console.log(rootFolder);
const rootNode = {
  name: path.basename(filename).replace(/\.jsx?/, ''),
  filename,
  depth: 0,
  children: [],
};

// Options for module resolver
let aliasLookup = [];
// Use directory of root file as part of modules list the resolver will search in
// when resolving imports

try {
  // eslint-disable-next-line
  const config = require(path.resolve(webpackConfigPath));
  if (config != null && config.resolve != null && config.resolve.alias != null) {
    aliasLookup = config.resolve.alias;
  }
} catch (e) { console.log(e.stack); }

function extractModules(bodyItem) {
  if (
    bodyItem.type === 'ImportDeclaration' && !bodyItem.source.value.endsWith('css')
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
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (
      tokens[i].type.label === 'jsxTagStart' && tokens[i + 1].type.label === 'jsxName'
    ) {
      childComponent = _.find(imports, { name: tokens[i + 1].value });
      if (childComponent) {
        childComponents.push(childComponent);
      }
    } else if (
      tokens[i].type.label === 'jsxName' && tokens[i].value === 'component'
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

// The path resolver looks up a folder like this 'Components' -> 'clients/components',
// and performs a string replacement
function resolveAliasedFilePath(node) {
  let resolvedPath = node.source;
  console.log('node.source', resolvedPath);
  const chain = node.source.split('/');
  const aliasComponent = chain[0];
  const tail = chain.slice(1);
  console.log('aliasComponent', aliasComponent);
  // Match file name against aliases
  const value = aliasLookup[aliasComponent];
  console.log('aliasValue', value);
  if (typeof value === 'string') {
    const resolved = value.includes('/') ? value.split('/').join(path.sep) : value;
    resolvedPath = tail.length > 0 ? `${resolved}${path.sep}${tail.join(path.sep)}` : resolved;
  }
  console.log('resolved to', resolvedPath);
  return resolvedPath;
}

function formatChild(child, parent, depth) {
  const dir = path.dirname(parent.filename);
  const filePath = resolveAliasedFilePath(child);
  console.log(filePath);
  let f;
  let s;
  if (child.source.startsWith('.')) {
    // Relative import (./ or ../) - Not an alias
    f = path.resolve(`${dir}${path.sep}${child.source}`);
    s = filename.replace(`${process.cwd()}${path.sep}`, '');
  } else if (Object.keys(aliasLookup).length > 0 && typeof filePath === 'string') {
    f = filePath;
    s = filename.replace(`${process.cwd()}${path.sep}`, '');
  } else {
    // Third party component
    f = path.join(dir, child.source);
    s = child.source;
  }
  return {
    source: s, name: child.name, filename: f, children: [], depth,
  };
}

function extractExport(body) {
  let result;
  body.some((b) => {
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
  body.some((b) => {
    if (
      b.type === 'VariableDeclaration'
      && b.declarations[0].id.name === exportIdentifier
      && b.declarations[0].init.type === 'CallExpression'
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
  const imports = ast.program.body.map(extractModules)
    .filter(i => Boolean(i)).reduce((l, i) => l.concat(i), []);
  const match = ({ name }) => name === node.name;
  if (imports.some(match)) {
    const { source } = imports.filter(match).pop();
    // Resolve relative source
    const newPath = `${path.dirname(node.filename)}${path.sep}${source.split('/').slice(1).join(path.sep)}`;
    console.log('newPath', newPath);
    return [`${newPath}.jsx`, `${newPath}.js`];
  }
  return [];
}

function processFile(node, file, depth) {
  /** @todo Upgrade babylon */
  /** @warning Do not run this function if you are checking in an index file! */
  /** code below causes infinte loop! */
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
  const imports = ast.program.body.map(extractModules)
    .filter(i => Boolean(i)).reduce((l, i) => l.concat(i), []);
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
  const source = path.basename(path.dirname(node.filename)) === node.name
    ? node.source
    : node.source + path.sep + node.name;
  if (node.children.length < 1) {
    return {
      label: source,
      depth: node.depth,
    };
  }
  return {
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
  };
}

function done() {
  if (!rootNode.children) {
    console.error(
      'Could not find any components. Did you process the right file?',
    );
    process.exit(1);
  }
  if (outputJSON) writeFileSync('data.json', JSON.stringify(rootNode, null, 2));
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
  if (Object.keys(aliasLookup).length > 0 && typeof node.source === 'string') {
    const x = resolveAliasedFilePath(node);
    if (typeof x === 'string' && x !== node.source) possibleFileNames.push(...getPossibleNames(x));
  }
  possibleFileNames.push(...getPossibleNames(node.filename));
  if (parent && moduleDir) {
    const moduleName = node.filename.replace(path.dirname(parent.filename), moduleDir);
    possibleFileNames.push(...getPossibleNames(moduleName));
  }
  possibleFileNames.forEach((name) => {
    if (name.endsWith('index.js') || name.endsWith('index.jsx')) {
      try {
        const f = readFileSync(name, 'utf8');
        processIndexFile(node, f).forEach((newPath) => {
          const file = readFileSync(newPath, 'utf8');
          if (depth <= scanDepth) {
            processFile(node, file, depth);
          }
          node.children.forEach(c => processNode(c, depth + 1, node));
        });
      } catch (e) { console.log(e.message); }
    }
    node.filename = name;
    try {
      const file = readFileSync(node.filename, 'utf8');
      if (depth <= scanDepth) {
        processFile(node, file, depth);
      }
      node.children.forEach(c => processNode(c, depth + 1, node));
      return;
    } catch (e) { console.log(e.message); }
  });
  if (hideThirdParty) {
    node.hide = true;
  }
}

processNode(rootNode, 1);
done();
