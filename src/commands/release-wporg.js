/**
 * External dependencies
 */
import { diffArrays } from 'diff';
import fs from 'fs-extra';
import glob from 'glob-all';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import { resolve, basename } from 'path';

/**
 * Internal dependencies
 */
import fh from '../utils/file-header';
import git from '../utils/git';
import log from '../utils/logger';
import readme from '../utils/readme';
import str from '../utils/string';
import svn from '../utils/svn';

export default function( args, config ) {
	let params;
	try {
		params = getParams( args, config );

		getReleaseActions().forEach( action => {
			action( params );
		} );

		log.success( 'WP.org release is created: ' + getSvnUrl( params.slug, params.version ) );
	} catch ( e ) {
		log.error( e.toString() );
	}

	afterRelease( params );
}

function getSvnUrl( slug, tag ) {
	const url = `https://plugins.svn.wordpress.org/${ slug }`;
	return tag ? url + '/' + tag : url;
}

function getParams( args, config ) {
	const files = config.files || {};
	const mainFile = args.file || files.main;

	const buildFiles = getBuildFiles( files );
	const assets = getAssetFiles( files );

	const type = args.type || config.type || 'plugin';
	const wporg = config.wporg || {};
	const slug = args.slug || wporg.slug;
	if ( ! slug ) {
		throw new Error( 'Missing wp.org slug. Specify it via --slug or define `wporg.slug` in .wpt.yml.' );
	}

	const originalBranch = git.getCurrentBranch();
	const gh = config.gh || {};
	const branch = args.branch || gh.branch || 'master';

	const username = args.username || wporg.username;
	const buildPath = args.buildPath || wporg.buildPath;
	if ( ! buildPath ) {
		throw new Error( 'Missing build path. Specify it via `wporg.buildPath` in .wpt.yml' );
	}

	const data = fh.getFileData( mainFile, type );
	const version = data.Version;

	return {
		originalBranch,
		branch,
		slug,
		username,
		version,
		buildPath,
		buildFiles,
		assets,
	};
}

function getBuildFiles( configFiles ) {
	const assets = getAssetFiles( configFiles );
	const src = configFiles.src;
	if ( ! src ) {
		throw new Error( 'Missing files to build. Specify it via `files.src` in .wpt.yml.' );
	}
	const filterNotAssets = ( filepath ) => {
		let isAsset = false;
		for ( let i = 0; i < assets.length; i++ ) {
			isAsset = ( fs.statSync( filepath ).isFile() && assets[ i ] === filepath );
			if ( isAsset ) {
				break;
			}
		}

		return ! isAsset;
	};
	return glob.sync( src ).filter( filterNotAssets );
}

function getAssetFiles( configFiles ) {
	const assets = glob.sync( configFiles.assets || [] );
	if ( ! assets ) {
		throw new Error( 'Missing assets for wp.org. Specify it via `files.assets` in .wpt.yml.' );
	}
	return assets;
}

function getReleaseActions() {
	return [
		switchGitBranch,
		checkBeforeCopy,
		cleanBuild,
		svnCheckout,
		copyFiles,
		svnCommitTrunk,
		svnCommitAssets,
		svnCreateTag,
		cleanBuild
	];
}

function switchGitBranch( params ) {
	git.checkout( params.branch );
}

function checkBeforeCopy( params ) {
	git.checkUncommittedChanges();
	readme.checkVersion( params.version );
}

function cleanBuild( params ) {
	rimraf.sync( params.buildPath );
}

function svnCheckout( params ) {
	svn.checkout( getSvnUrl( params.slug ), rootBuild( params ) );
	svn.update( trunkDir( params ), '--set-depth', 'infinity' );
	svn.update( assetsDir( params ), '--set-depth', 'infinity' );
}

function rootBuild( params ) {
	return resolve( params.buildPath );
}

function trunkDir( params ) {
	return resolve( params.buildPath, 'trunk' );
}

function assetsDir( params ) {
	return resolve( params.buildPath, 'assets' );
}

function unbaseFiles( base, files ) {
	const baseLen = str.untrailingslashit( base ).length;
	return files.map( file => {
		const unbase = str.untrailingslashit( file ).substring( baseLen );
		return '/' === unbase.charAt( 0 )
			? unbase.substring( 1 )
			: unbase;
	} );
}

function copyFiles( params ) {
	// Remove all files in trunk and assets that are no longer exist.
	removeUnindexedInTrunk( params );
	removeUnindexedInAssets( params );

	const trunk = trunkDir( params );
	const assets = assetsDir( params );
	const copyToTrunk = copyFileCallback( trunk );
	const copyToAssets = copyFileCallback( assets, { copyDir: false } );

	// Copy src files to trunk.
	params.buildFiles.forEach( copyToTrunk );

	mkdirp( assets );

	// Copy assets to svn assets.
	params.assets.forEach( copyToAssets );
}

function removeUnindexedInTrunk( params ) {
	const svnTrunk = glob.sync( [ str.trailingslashit( params.buildPath ) + 'trunk/**' ] );
	const base = str.trailingslashit( params.buildPath ) + 'trunk';
	const from = unbaseFiles( base, svnTrunk ).filter( str.notEmpty );
	const to = params.buildFiles;

	removeFilesFromDiff( resolve( params.buildPath, 'trunk' ), from, to );
}

function removeUnindexedInAssets( params ) {
	const svnAssets = glob.sync( [ str.trailingslashit( params.buildPath ) + 'assets/**' ] );
	const base = str.trailingslashit( params.buildPath ) + 'assets';
	const from = unbaseFiles( base, svnAssets ).filter( str.notEmpty );
	const to = params.assets.map( f => {
		return basename( f );
	} );

	removeFilesFromDiff( resolve( params.buildPath, 'assets' ), from, to );
}

function removeFilesFromDiff( base, from, to ) {
	diffArrays( from, to ).forEach( d => {
		if ( d.removed && d.value ) {
			d.value.forEach( f => {
				rimraf.sync( resolve( base, f ) );
			} );
		}
	} );
}

function copyFileCallback( dst, opts ) {
	opts = opts || { copyDir: true };

	return ( filepath ) => {
		const stat = fs.statSync( filepath );
		if ( stat.isDirectory() && opts.copyDir ) {
			mkdirp( resolve( dst, filepath ) );
		} else if ( stat.isFile() ) {
			fs.copySync(
				filepath,
				opts.copyDir
				? resolve( dst, filepath )
				: resolve( dst, basename( filepath ) )
			);
		}
	};
}

function svnCommitTrunk( params ) {
	const trunk = trunkDir( params );

	svn.missingItems( trunk ).forEach( svn.del );
	svn.untrackedItems( trunk ).forEach( svn.add );
	svn.commit( trunk, params.username, `Updates trunk for ${ params.version }` );
}

function svnCommitAssets( params ) {
	const assets = assetsDir( params );

	svn.missingItems( assets ).forEach( svn.del );
	svn.untrackedItems( assets ).forEach( svn.add );
	svn.update( assets, '--accept', 'mine-full' );
	svn.commit( assets, params.username, `Updates assets for ${ params.version }` );
}

function svnCreateTag( params ) {
	const from = resolve( params.buildPath, 'trunk' );
	const to = resolve( params.buildPath, 'tags', params.version );

	svn.update( to );
	svn.copy( from, to );

	// Copying the same src to dst in the second time will makes the whole trunk
	// directory appears in tag. Third time will cause E150002 -- directory
	// already exists.
	svn.del( resolve( to, 'trunk' ) );

	svn.commit( to, params.username, `Creates tag ${ params.version }` );
}

function afterRelease( params ) {
	try {
		git.checkout( params.originalBranch );
	} catch ( e ) {}
}
