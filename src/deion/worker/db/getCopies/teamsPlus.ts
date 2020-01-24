import orderBy from "lodash/orderBy";
import { mergeByPk } from "./helpers";
import { team } from "../../core";
import { idb } from "..";
import { g, helpers, overrides } from "../../util";
import {
	Team,
	TeamAttr,
	TeamFiltered,
	TeamSeasonAttr,
	TeamStatAttr,
	TeamStatType,
	TeamStats,
} from "../../../common/types";

export type TeamsPlusOptions = {
	tid?: number;
	season?: number;
	attrs?: TeamAttr[];
	seasonAttrs?: TeamSeasonAttr[];
	stats?: TeamStatAttr[];
	playoffs?: boolean;
	regularSeason?: boolean;
	statType?: TeamStatType;
};

const processAttrs = <
	Attrs extends Readonly<TeamAttr[]>,
	SeasonAttrs extends Readonly<TeamSeasonAttr[]>
>(
	output: TeamFiltered<Attrs, SeasonAttrs>,
	t: Team,
	attrs: Attrs,
) => {
	for (const attr of attrs) {
		if (attr === "budget") {
			// @ts-ignore
			output.budget = helpers.deepCopy(t.budget);

			// @ts-ignore
			for (const [key, value] of Object.entries(output.budget)) {
				if (key !== "ticketPrice") {
					// ticketPrice is the only thing in dollars always
					// @ts-ignore
					value.amount /= 1000;
				}
			}
		} else {
			// @ts-ignore
			output[attr] = t[attr];
		}
	}
};

const processSeasonAttrs = async <
	Attrs extends Readonly<TeamAttr[]>,
	SeasonAttrs extends Readonly<TeamSeasonAttr[]>
>(
	output: TeamFiltered<Attrs, SeasonAttrs>,
	t: Team,
	seasonAttrs: SeasonAttrs,
	season: number | undefined,
) => {
	let seasons;

	if (season === undefined) {
		// All seasons
		seasons = mergeByPk(
			await idb.league
				.transaction("teamSeasons")
				.store.index("tid, season")
				.getAll(IDBKeyRange.bound([t.tid], [t.tid, ""])),
			await idb.cache.teamSeasons.indexGetAll("teamSeasonsByTidSeason", [
				[t.tid],
				[t.tid, "Z"],
			]),
			idb.cache.storeInfos.teamSeasons.pk,
		);
	} else if (season >= g.get("season") - 2) {
		// Single season, from cache
		seasons = await idb.cache.teamSeasons.indexGetAll(
			"teamSeasonsBySeasonTid",
			[
				[season, t.tid],
				[season, t.tid],
			],
		);
	} else {
		// Single season, from database
		seasons = await idb.league
			.transaction("teamSeasons")
			.store.index("season, tid")
			.getAll([season, t.tid]);
	}

	// If a season is requested but not in the database, make a fake season so at least some dummy values are returned
	if (season !== undefined && seasons.length === 0) {
		const dummySeason = team.genSeasonRow(t.tid);
		dummySeason.season = season;
		seasons = [dummySeason];
	}

	output.seasonAttrs = await Promise.all(
		seasons.map(async ts => {
			const row: any = {}; // Revenue and expenses calculation

			const revenue = Object.keys(ts.revenues).reduce(
				(memo, rev) => memo + ts.revenues[rev].amount,
				0,
			);
			const expense = Object.keys(ts.expenses).reduce(
				(memo, rev) => memo + ts.expenses[rev].amount,
				0,
			);

			for (const temp of seasonAttrs) {
				const attr: string = temp;
				if (attr === "winp") {
					row.winp = helpers.calcWinp(ts);
				} else if (attr === "att") {
					row.att = 0;

					if (!ts.hasOwnProperty("gpHome")) {
						ts.gpHome = Math.round(ts.gp / 2);
					}

					// See also game.js and teamFinances.js
					if (ts.gpHome > 0) {
						row.att = ts.att / ts.gpHome;
					}
				} else if (attr === "cash") {
					row.cash = ts.cash / 1000; // [millions of dollars]
				} else if (attr === "revenue") {
					row.revenue = revenue / 1000; // [millions of dollars]
				} else if (attr === "profit") {
					row.profit = (revenue - expense) / 1000; // [millions of dollars]
				} else if (attr === "salaryPaid") {
					row.salaryPaid = ts.expenses.salary.amount / 1000; // [millions of dollars]
				} else if (attr === "payroll") {
					if (season === g.get("season")) {
						row.payroll = (await team.getPayroll(t.tid)) / 1000;
					} else {
						row.payroll = undefined;
					}
				} else if (attr === "lastTen") {
					const lastTenWon = ts.lastTen.filter(x => x === 1).length;
					const lastTenLost = ts.lastTen.filter(x => x === 0).length;
					row.lastTen = `${lastTenWon}-${lastTenLost}`;

					if (g.get("ties")) {
						const lastTenTied = ts.lastTen.filter(x => x === -1).length;
						row.lastTen += `-${lastTenTied}`;
					}
				} else if (attr === "streak") {
					// For standings
					if (ts.streak === 0) {
						row.streak = "None";
					} else if (ts.streak > 0) {
						row.streak = `Won ${ts.streak}`;
					} else if (ts.streak < 0) {
						row.streak = `Lost ${Math.abs(ts.streak)}`;
					}
				} else {
					row[attr] = ts[attr];
				}
			}

			return row;
		}),
	);

	if (season !== undefined) {
		output.seasonAttrs = output.seasonAttrs[0];
	}
};

// Indexes can't handle playoffs/regularSeason and different ones can come back inconsistently sorted
const filterOrderStats = (
	stats: TeamStats[],
	playoffs: boolean,
	regularSeason: boolean,
): TeamStats[] => {
	return orderBy(
		helpers.deepCopy(
			stats.filter(ts => {
				if (playoffs && ts.playoffs) {
					return true;
				}

				if (regularSeason && !ts.playoffs) {
					return true;
				}

				return false;
			}),
		),
		["season", "playoffs", "rid"],
	);
};

const processStats = async <
	Attrs extends Readonly<TeamAttr[]>,
	SeasonAttrs extends Readonly<TeamSeasonAttr[]>
>(
	output: TeamFiltered<Attrs, SeasonAttrs>,
	t: Team,
	stats: TeamStatAttr[],
	playoffs: boolean,
	regularSeason: boolean,
	statType: TeamStatType,
	season?: number,
) => {
	let teamStats;

	const teamStatsFromCache = async () => {
		// Single season, from cache
		let teamStats2: TeamStats[] = [];

		if (regularSeason) {
			teamStats2 = teamStats2.concat(
				await idb.cache.teamStats.indexGetAll("teamStatsByPlayoffsTid", [
					[false, t.tid],
					[false, t.tid],
				]),
			);
		}

		if (playoffs) {
			teamStats2 = teamStats2.concat(
				await idb.cache.teamStats.indexGetAll("teamStatsByPlayoffsTid", [
					[true, t.tid],
					[true, t.tid],
				]),
			);
		}

		return teamStats2;
	};

	if (season === undefined) {
		// All seasons
		teamStats = mergeByPk(
			await idb.league
				.transaction("teamStats")
				.store.index("tid")
				.getAll(t.tid),
			await teamStatsFromCache(),
			idb.cache.storeInfos.teamStats.pk,
		);
	} else if (season === g.get("season")) {
		teamStats = await teamStatsFromCache();
	} else {
		// Single season, from database
		teamStats = await idb.league
			.transaction("teamStats")
			.store.index("season, tid")
			.getAll([season, t.tid]);
	}

	// Handle playoffs/regularSeason
	teamStats = filterOrderStats(teamStats, playoffs, regularSeason);

	if (teamStats.length === 0) {
		teamStats.push({});
	}

	output.stats = teamStats.map(ts => {
		if (!overrides.core.team.processStats) {
			throw new Error("Missing overrides.core.team.processStats");
		}

		return overrides.core.team.processStats(ts, stats, playoffs, statType);
	});

	if (
		season !== undefined &&
		((playoffs && !regularSeason) || (!playoffs && regularSeason))
	) {
		output.stats = output.stats[0];
	}
};

const processTeam = async <
	Attrs extends Readonly<TeamAttr[]>,
	SeasonAttrs extends Readonly<TeamSeasonAttr[]>
>(
	t: Team,
	{
		season,
		attrs,
		seasonAttrs,
		stats,
		playoffs,
		regularSeason,
		statType,
	}: {
		season?: number;
		attrs: Attrs;
		seasonAttrs: SeasonAttrs;
		stats: TeamStatAttr[];
		playoffs: boolean;
		regularSeason: boolean;
		statType: TeamStatType;
	},
) => {
	// @ts-ignore
	const output: TeamFiltered<Attrs, SeasonAttrs> = {};

	if (attrs.length > 0) {
		processAttrs(output, t, attrs);
	}

	const promises: Promise<any>[] = [];

	if (seasonAttrs.length > 0) {
		promises.push(processSeasonAttrs(output, t, seasonAttrs, season));
	}

	if (stats.length > 0) {
		promises.push(
			processStats(output, t, stats, playoffs, regularSeason, statType, season),
		);
	}

	await Promise.all(promises);
	return output;
};

/**
 * Retrieve a filtered copy of a team object, or an array of all team objects.
 *
 * This can be used to retrieve information about a certain season, compute average statistics from the raw data, etc.
 *
 * If you request just one season (so, explicitly set season and then only one of playoffs and regularSeason is true), then stats and seasonAttrs will be returned as an object. Otherwise, they will be arrays of objects.
 *
 * @memberOf core.team
 * @param {Object} options Options, as described below.
 * @param {number=} options.tid Team ID. Set this if you want to return only one team object. If undefined, an array of all teams is returned, ordered by tid.
 * @param {number=} options.season Season to retrieve stats/seasonAttrs for. If undefined, all seasons will be returned.
 * @param {Array.<string>=} options.attrs List of team attributes to include in output (e.g. region, abbrev, name, ...).
 * @param {Array.<string>=} options.seasonAttrs List of seasonal team attributes to include in output (e.g. won, lost, payroll, ...).
 * @param {Array.<string=>} options.stats List of team stats to include in output (e.g. fg, orb, ast, blk, ...).
 * @param {boolean=} options.playoffs Boolean representing whether to return playoff stats or not; default is false.
 * @param {boolean=} options.regularSeason Boolean representing whether to return playoff stats or not; default is false.
 * @param {string=} options.statType What type of stats to return, 'perGame' or 'totals' (default is 'perGame).
 * @return {Promise.(Object|Array.<Object>)} Filtered team object or array of filtered team objects, depending on the inputs.
 */
async function getCopies<
	Attrs extends Readonly<TeamAttr[]>,
	SeasonAttrs extends Readonly<TeamSeasonAttr[]>
>({
	tid,
	season,
	attrs = ([] as never) as Attrs,
	seasonAttrs = ([] as never) as SeasonAttrs,
	stats = [],
	playoffs = false,
	regularSeason = true,
	statType = "perGame",
}: {
	tid?: number;
	season?: number;
	attrs?: Attrs;
	seasonAttrs?: SeasonAttrs;
	stats?: any[];
	playoffs?: boolean;
	regularSeason?: boolean;
	statType?: TeamStatType;
} = {}): Promise<TeamFiltered<Attrs, SeasonAttrs>[]> {
	const options = {
		season,
		attrs,
		seasonAttrs,
		stats,
		playoffs,
		regularSeason,
		statType,
	};

	if (tid === undefined) {
		const teams = await idb.cache.teams.getAll();
		return Promise.all(teams.map(t => processTeam(t, options)));
	}

	const t = await idb.cache.teams.get(tid);
	if (t) {
		return [await processTeam(t, options)];
	}

	return [];
}

export default getCopies;