import { bySport } from "../../../common";
import ovrBasketball from "./ovr.basketball";
import ovrFootball from "./ovr.football";
import ovrHockey from "./ovr.hockey";

const ovr = (
	players: {
		ratings: {
			ovr: number;
			ovrs: Record<string, number> | undefined;
			pos: string;
		};
	}[],
	options: {
		pos?: string;
		rating?: string;
	} = {},
) => {
	return bySport({
		basketball: ovrBasketball(players, options.rating),
		football: ovrFootball(players, options.pos),
		hockey: ovrHockey(players as any, options.pos),
	});
};

export default ovr;
