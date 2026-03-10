type User = {
	id: string;
	email: string;
	name: string;
	balance: number;
	createdAt: Date;
	stocks: {
		symbol: string;
		quantity: number;
		id: number;
	}[];
};

export default User;
